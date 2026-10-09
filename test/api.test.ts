import { describe, expect, it } from 'vitest'
import { APP_OPEN_URL, buildApp } from '../src/app'

const day = (n: number, hour = 12) => new Date(Date.UTC(2026, 9, 1 + n, hour))

function setup() {
  const clock = { current: day(0), now: () => new Date(clock.current) }
  const app = buildApp({ clock })
  const at = (d: Date) => (clock.current = d)

  const click = async (query: string) => {
    const res = await app.inject({ method: 'GET', url: `/r?${query}` })
    expect(res.statusCode).toBe(302)
    return new URL(res.headers.location as string).searchParams.get('click_id')!
  }
  const firstOpen = (device: string) => app.inject({ method: 'POST', url: `/devices/${device}/first-open` })
  const open = (device: string, click_id: string) =>
    app.inject({ method: 'POST', url: `/devices/${device}/touches`, payload: { click_id } })
  const signup = (user_id: string, device_id: string, signed_up_at?: string) =>
    app.inject({ method: 'POST', url: '/signups', payload: { user_id, device_id, signed_up_at } })
  const attribution = (user_id: string) => app.inject({ method: 'GET', url: `/signups/${user_id}/attribution` })

  return { app, at, click, firstOpen, open, signup, attribution }
}

describe('API: contrato do link e primeira abertura', () => {
  it('o link carrega tudo na URL: o servidor gera click_id e redireciona para o app sem depender de referrer', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'GET', url: '/r?src=campaign&cid=black-friday-2026' })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(new RegExp(`^${APP_OPEN_URL}\\?click_id=[0-9a-f-]{36}$`))
    const again = await app.inject({ method: 'GET', url: '/r?src=campaign&cid=black-friday-2026' })
    expect(again.headers.location).not.toBe(res.headers.location)
  })

  it('link com src desconhecido ou sem identificador responde 400 em português', async () => {
    const { app } = setup()
    const semSrc = await app.inject({ method: 'GET', url: '/r?src=toString' })
    const semRef = await app.inject({ method: 'GET', url: '/r?src=referral&cid=x' })

    expect(semSrc.statusCode).toBe(400)
    expect(semSrc.json().error).toBe('src deve ser campaign, referral ou community')
    expect(semRef.statusCode).toBe(400)
    expect(semRef.json().error).toMatch(/^ref é obrigatório para src=referral/)
  })

  it('primeira abertura é gravada uma vez só: aberturas seguintes não mudam first_open_at', async () => {
    const { at, firstOpen } = setup()
    const primeira = await firstOpen('dev-1')
    at(day(3))
    const segunda = await firstOpen('dev-1')

    expect(primeira.statusCode).toBe(201)
    expect(segunda.statusCode).toBe(200)
    expect(segunda.json()).toEqual({ device_id: 'dev-1', first_open_at: day(0).toISOString(), already_recorded: true })
  })
})

describe('API: cadastro e auditoria', () => {
  it('link de campanha e de indicação antes do cadastro: a resposta lista os dois toques e o motivo de cada um', async () => {
    const { at, click, firstOpen, open, signup, attribution } = setup()
    const campanha = await click('src=campaign&cid=black-friday-2026')
    await firstOpen('dev-1')
    await open('dev-1', campanha)
    at(day(1))
    const indicacao = await click('src=referral&ref=ana_criadora')
    await open('dev-1', indicacao)
    at(day(2))

    const res = await signup('user-1', 'dev-1')
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.origin).toEqual({ source: 'referral', click_id: indicacao, campaign_id: null, ref: 'ana_criadora' })
    expect(body.reason_code).toBe('last_touch_in_window')
    expect(body.window).toEqual({ days: 7, starts_at: day(0).toISOString(), ends_at: day(7).toISOString() })
    expect(body.touches.map((t: { click_id: string; outcome: string; reason: string }) => [t.click_id, t.outcome, t.reason])).toEqual([
      [campanha, 'lost', `perdeu para toque mais recente (${indicacao})`],
      [indicacao, 'won', 'venceu: toque mais recente dentro da janela e antes do cadastro'],
    ])
    expect((await attribution('user-1')).json()).toEqual(body)
  })

  it('empate de horário pela API: indicação vence campanha aberta no mesmo instante', async () => {
    const { click, firstOpen, open, signup } = setup()
    await firstOpen('dev-1')
    const campanha = await click('src=campaign&cid=lancamento')
    const indicacao = await click('src=referral&ref=bia')
    await open('dev-1', campanha)
    await open('dev-1', indicacao)

    const body = (await signup('user-1', 'dev-1')).json()
    expect(body.origin.click_id).toBe(indicacao)
    expect(body.touches[0].reason_code).toBe('lost_tie_channel')
  })

  it('janela medida da primeira abertura: clique de 10 dias atrás entregue na primeira abertura vence', async () => {
    const { at, click, firstOpen, open, signup } = setup()
    at(day(-10))
    const antigo = await click('src=community&cid=discord-criadores')
    at(day(0))
    await firstOpen('dev-1')
    await open('dev-1', antigo) // deferred deep link: click_id came through the install referrer
    at(day(2))

    const body = (await signup('user-1', 'dev-1')).json()
    expect(body.origin).toMatchObject({ source: 'community', click_id: antigo, campaign_id: 'discord-criadores' })
    expect(body.touches[0]).toMatchObject({ clicked_at: day(-10).toISOString(), opened_at: day(0).toISOString(), outcome: 'won' })
  })

  it('toque fora da janela pela API: link aberto 8 dias depois da primeira abertura não vence', async () => {
    const { at, click, firstOpen, open, signup } = setup()
    await firstOpen('dev-1')
    at(day(8))
    await open('dev-1', await click('src=campaign&cid=tardia'))

    const body = (await signup('user-1', 'dev-1')).json()
    expect(body.origin.source).toBe('organic')
    expect(body.reason_code).toBe('all_touches_outside_window')
    expect(body.touches[0].reason).toMatch(/^fora da janela de 7 dias a partir da primeira abertura/)
  })

  it('cadastro sem toque fica orgânico com motivo gravado e consultável depois', async () => {
    const { firstOpen, signup, attribution } = setup()
    await firstOpen('dev-1')
    await signup('user-1', 'dev-1')

    const body = (await attribution('user-1')).json()
    expect(body.origin).toEqual({ source: 'organic', click_id: null, campaign_id: null, ref: null })
    expect(body.reason_code).toBe('no_touches')
    expect(body.reason).toBe('nenhum link aberto neste dispositivo')
  })

  it('cadastro informado com horário anterior ao toque: toque posterior ao cadastro não vence', async () => {
    const { at, click, firstOpen, open, signup } = setup()
    await firstOpen('dev-1')
    at(day(3))
    await open('dev-1', await click('src=referral&ref=ana'))

    const body = (await signup('user-1', 'dev-1', day(2).toISOString())).json()
    expect(body.reason_code).toBe('all_touches_after_signup')
    expect(body.touches[0]).toMatchObject({ outcome: 'lost', reason: 'posterior ao cadastro' })
  })

  it('link aberto depois do cadastro não muda a origem gravada', async () => {
    const { at, click, firstOpen, open, signup, attribution } = setup()
    await firstOpen('dev-1')
    const campanha = await click('src=campaign&cid=black-friday-2026')
    await open('dev-1', campanha)
    const gravado = (await signup('user-1', 'dev-1')).json()
    at(day(1))
    await open('dev-1', await click('src=referral&ref=ana'))

    expect((await attribution('user-1')).json()).toEqual(gravado)
    expect(gravado.origin.click_id).toBe(campanha)
  })

  it('cadastro em data futura ou inválida responde 400', async () => {
    const { firstOpen, signup } = setup()
    await firstOpen('dev-1')
    expect((await signup('user-1', 'dev-1', day(1).toISOString())).statusCode).toBe(400)
    expect((await signup('user-1', 'dev-1', 'ontem')).statusCode).toBe(400)
    expect((await signup('user-1', 'dev-1', '1')).statusCode).toBe(400)
    expect((await signup('user-1', 'dev-1', '2026-10-01')).statusCode).toBe(400)
  })
})

describe('API: o mesmo clique não cria duas origens', () => {
  it('mesmo link aberto duas vezes: dois click_id, dois toques na auditoria e uma origem só', async () => {
    const { at, click, firstOpen, open, signup } = setup()
    await firstOpen('dev-1')
    const primeiro = await click('src=campaign&cid=black-friday-2026')
    await open('dev-1', primeiro)
    at(day(1))
    const segundo = await click('src=campaign&cid=black-friday-2026')
    await open('dev-1', segundo)

    const body = (await signup('user-1', 'dev-1')).json()
    expect(segundo).not.toBe(primeiro)
    expect(body.origin).toMatchObject({ source: 'campaign', campaign_id: 'black-friday-2026', click_id: segundo })
    expect(body.touches.map((t: { reason_code: string }) => t.reason_code)).toEqual(['lost_to_later', 'won'])
  })

  it('o mesmo clique reportado duas vezes pelo app cria um toque só', async () => {
    const { at, click, firstOpen, open, signup } = setup()
    await firstOpen('dev-1')
    const c = await click('src=campaign&cid=black-friday-2026')
    const primeiro = await open('dev-1', c)
    at(day(1))
    const repetido = await open('dev-1', c)

    expect(primeiro.statusCode).toBe(201)
    expect(repetido.statusCode).toBe(200)
    expect(repetido.json()).toMatchObject({ duplicate: true, touch: { opened_at: day(0).toISOString() } })
    expect((await signup('user-1', 'dev-1')).json().touches).toHaveLength(1)
  })

  it('o mesmo clique não pode virar toque em outro dispositivo', async () => {
    const { click, firstOpen, open } = setup()
    await firstOpen('dev-1')
    await firstOpen('dev-2')
    const c = await click('src=referral&ref=ana')
    await open('dev-1', c)

    const res = await open('dev-2', c)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('clique já registrado em outro dispositivo')
  })

  it('segundo cadastro no mesmo dispositivo não reaproveita o clique que já virou origem', async () => {
    const { at, click, firstOpen, open, signup } = setup()
    await firstOpen('dev-1')
    const c = await click('src=referral&ref=ana')
    await open('dev-1', c)
    await signup('user-1', 'dev-1')
    at(day(1))

    const segundo = (await signup('user-2', 'dev-1')).json()
    expect(segundo.origin.source).toBe('organic')
    expect(segundo.reason_code).toBe('all_touches_already_used')
    expect(segundo.touches[0]).toMatchObject({ click_id: c, outcome: 'lost', reason: 'já considerado no cadastro user-1' })
  })

  it('toque posterior a um cadastro não fica preso a ele e pode ser a origem do próximo cadastro no aparelho', async () => {
    const { at, click, firstOpen, open, signup } = setup()
    await firstOpen('dev-1')
    at(day(3))
    const c = await click('src=referral&ref=ana')
    await open('dev-1', c)
    expect((await signup('user-1', 'dev-1', day(2).toISOString())).json().touches[0].reason_code).toBe('after_signup')

    const segundo = (await signup('user-2', 'dev-1')).json()
    expect(segundo.origin.click_id).toBe(c)
  })

  it('cadastro repetido com o mesmo user_id devolve a decisão gravada, sem decidir de novo', async () => {
    const { at, click, firstOpen, open, signup } = setup()
    await firstOpen('dev-1')
    await open('dev-1', await click('src=campaign&cid=black-friday-2026'))
    const primeiro = await signup('user-1', 'dev-1')
    at(day(1))
    const repetido = await signup('user-1', 'dev-1')

    expect(primeiro.statusCode).toBe(201)
    expect(repetido.statusCode).toBe(200)
    expect(repetido.json()).toEqual(primeiro.json())
    expect((await signup('user-1', 'dev-2')).statusCode).toBe(409)
  })
})
