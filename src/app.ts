import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyReply } from 'fastify'
import { decideOrigin, WINDOW_DAYS, type Source } from './attribution'
import { MemoryStore, type Store } from './store'

export interface Clock {
  now(): Date
}

/** Universal link / App Link: opens the app when installed; otherwise the page sends to the store carrying click_id. */
export const APP_OPEN_URL = 'https://appconty.com/app/open'

/** Which query param identifies each source on the link. */
const LINK_PARAM: Record<Source, 'cid' | 'ref'> = { campaign: 'cid', community: 'cid', referral: 'ref' }
const ID = /^[\w-]{1,64}$/
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error })

export function buildApp({ clock, store = new MemoryStore(), windowDays = WINDOW_DAYS }: { clock: Clock; store?: Store; windowDays?: number }) {
  const app = Fastify()

  // 1. The link. Everything travels in the URL, so a webview that drops the Referer header changes nothing.
  app.get<{ Querystring: Record<string, unknown> }>('/r', async (req, reply) => {
    const { src } = req.query
    if (typeof src !== 'string' || !Object.hasOwn(LINK_PARAM, src)) {
      return fail(reply, 400, 'src deve ser campaign, referral ou community')
    }
    const source = src as Source
    const param = LINK_PARAM[source]
    const value = req.query[param]
    if (!isId(value)) return fail(reply, 400, `${param} é obrigatório para src=${source} (letras, números, _ ou -, até 64)`)

    const click_id = randomUUID()
    store.saveClick({
      click_id,
      source,
      campaign_id: param === 'cid' ? value : null,
      ref: param === 'ref' ? value : null,
      clicked_at: clock.now(),
    })
    return reply.redirect(`${APP_OPEN_URL}?click_id=${click_id}`, 302)
  })

  // 2. App launch. The app generates device_id once per install and calls this on every launch.
  app.post<{ Params: { deviceId: string } }>('/devices/:deviceId/first-open', async (req, reply) => {
    if (!isId(req.params.deviceId)) return fail(reply, 400, 'device_id inválido (letras, números, _ ou -, até 64)')
    const { device, created } = store.recordFirstOpen(req.params.deviceId, clock.now())
    return reply.code(created ? 201 : 200).send({ ...device, already_recorded: !created })
  })

  // 3. The app received a link (deep link, or install referrer on first open) and reports its click_id.
  app.post<{ Params: { deviceId: string }; Body: { click_id?: unknown } | undefined }>('/devices/:deviceId/touches', async (req, reply) => {
    const device = store.findDevice(req.params.deviceId)
    if (!device) return fail(reply, 404, 'dispositivo sem primeira abertura registrada; chame POST /devices/:deviceId/first-open antes')
    const click_id = req.body?.click_id
    if (typeof click_id !== 'string') return fail(reply, 400, 'click_id é obrigatório')
    const click = store.findClick(click_id)
    if (!click) return fail(reply, 404, 'clique não encontrado')

    const existing = store.findTouch(click_id)
    if (existing && existing.device_id !== device.device_id) return fail(reply, 409, 'clique já registrado em outro dispositivo')
    if (existing) return reply.code(200).send({ touch: existing, duplicate: true })

    const touch = { ...click, device_id: device.device_id, opened_at: clock.now(), used_by: null }
    store.addTouch(touch)
    return reply.code(201).send({ touch, duplicate: false })
  })

  // 4. Signup consumes the device's touches and freezes the decision. Called by the account service.
  app.post<{ Body: { user_id?: unknown; device_id?: unknown; signed_up_at?: unknown } | undefined }>('/signups', async (req, reply) => {
    const { user_id, device_id, signed_up_at } = req.body ?? {}
    if (!isId(user_id)) return fail(reply, 400, 'user_id é obrigatório (letras, números, _ ou -, até 64)')
    if (!isId(device_id)) return fail(reply, 400, 'device_id é obrigatório (letras, números, _ ou -, até 64)')

    const existing = store.findSignup(user_id)
    if (existing && existing.device_id !== device_id) return fail(reply, 409, 'user_id já cadastrado com outro dispositivo')
    if (existing) return reply.code(200).send(existing)

    const now = clock.now()
    const signedUpAt = signed_up_at === undefined ? now : new Date(typeof signed_up_at === 'string' ? signed_up_at : NaN)
    if (Number.isNaN(signedUpAt.getTime()) || signedUpAt > now) {
      return fail(reply, 400, 'signed_up_at deve ser data ISO 8601 que não esteja no futuro')
    }

    const decision = decideOrigin({
      first_open_at: store.findDevice(device_id)?.first_open_at ?? null,
      signed_up_at: signedUpAt,
      window_days: windowDays,
      touches: store.touchesOf(device_id),
    })
    const signup = { user_id, device_id, signed_up_at: signedUpAt, decided_at: now, ...decision }
    store.saveSignup(signup, decision.touches.filter((t) => t.reason_code !== 'already_used').map((t) => t.click_id))
    return reply.code(201).send(signup)
  })

  // 5. Audit: the frozen decision, with every touch considered and why it won or lost.
  app.get<{ Params: { userId: string } }>('/signups/:userId/attribution', async (req, reply) => {
    const signup = store.findSignup(req.params.userId)
    return signup ?? fail(reply, 404, 'cadastro não encontrado')
  })

  return app
}
