// The attribution rule lives here and only here. The README describes this file.

export type Source = 'referral' | 'campaign' | 'community'

/** Origin validity window, in days, counted from the device's first open (not from the click). */
export const WINDOW_DAYS = 7

/** Tie on exact opened_at: higher number wins. Still tied: smallest click_id (plain lexicographic order). */
export const CHANNEL_PRIORITY: Record<Source, number> = { referral: 3, campaign: 2, community: 1 }

const LABEL: Record<Source, string> = { referral: 'indicação', campaign: 'campanha', community: 'comunidade' }
const DAY_MS = 24 * 60 * 60 * 1000

/** Created by the server on the redirect (GET /r). click_id is the only thing the app needs to carry. */
export interface Click {
  click_id: string
  source: Source
  campaign_id: string | null
  ref: string | null
  clicked_at: Date
}

/** A click that reached the app on a device. */
export interface Touch extends Click {
  device_id: string
  /** When the app received the link: deep link, or deferred deep link on first open. Server time. */
  opened_at: Date
  /** user_id of the signup that already judged this touch; a touch takes part in one decision only. */
  used_by: string | null
}

export type TouchReasonCode =
  | 'won'
  | 'lost_to_later'
  | 'lost_tie_channel'
  | 'lost_tie_click_id'
  | 'after_signup'
  | 'outside_window'
  | 'already_used'

export interface JudgedTouch extends Touch {
  outcome: 'won' | 'lost'
  reason_code: TouchReasonCode
  reason: string
}

export type OriginReasonCode =
  | 'last_touch_in_window'
  | 'no_first_open'
  | 'no_touches'
  | 'all_touches_after_signup'
  | 'all_touches_outside_window'
  | 'all_touches_already_used'
  | 'no_eligible_touch'

const ORIGIN_REASON: Record<OriginReasonCode, string> = {
  last_touch_in_window: 'toque mais recente dentro da janela e antes do cadastro',
  no_first_open: 'dispositivo sem primeira abertura registrada, não há janela',
  no_touches: 'nenhum link aberto neste dispositivo',
  all_touches_after_signup: 'todos os toques são posteriores ao cadastro',
  all_touches_outside_window: 'todos os toques estão fora da janela',
  all_touches_already_used: 'todos os toques já foram considerados em outro cadastro',
  no_eligible_touch: 'nenhum toque válido; veja o motivo de cada um',
}

export interface Decision {
  origin: { source: Source | 'organic'; click_id: string | null; campaign_id: string | null; ref: string | null }
  reason_code: OriginReasonCode
  reason: string
  window: { days: number; starts_at: Date | null; ends_at: Date | null }
  /** Every touch the device had at decision time, in input order, each with won/lost and why. */
  touches: JudgedTouch[]
}

const ms = (d: Date) => d.getTime()

/** Most preferred first: latest opened_at, then channel priority, then smallest click_id. */
function byPreference(a: Touch, b: Touch): number {
  return (
    ms(b.opened_at) - ms(a.opened_at) ||
    CHANNEL_PRIORITY[b.source] - CHANNEL_PRIORITY[a.source] ||
    (a.click_id < b.click_id ? -1 : a.click_id > b.click_id ? 1 : 0)
  )
}

/**
 * Picks the origin of one signup. Pure: same input, same output.
 *
 * A touch is eligible when it was not used by another signup, was opened up to signed_up_at
 * (inclusive) and was opened inside [first_open_at, first_open_at + window_days] (inclusive).
 * Among eligible touches the winner is the last one (see byPreference). No eligible touch: organic,
 * with a reason code, never null.
 */
export function decideOrigin(input: {
  first_open_at: Date | null
  signed_up_at: Date
  window_days: number
  touches: Touch[]
}): Decision {
  const { first_open_at, signed_up_at, window_days, touches } = input
  const ends_at = first_open_at && new Date(ms(first_open_at) + window_days * DAY_MS)
  const window = { days: window_days, starts_at: first_open_at, ends_at }

  const ineligible = (t: Touch): [TouchReasonCode, string] | null => {
    if (t.used_by) return ['already_used', `já considerado no cadastro ${t.used_by}`]
    if (ms(t.opened_at) > ms(signed_up_at)) return ['after_signup', 'posterior ao cadastro']
    if (!first_open_at || !ends_at) return ['outside_window', 'sem primeira abertura registrada, não há janela']
    if (ms(t.opened_at) < ms(first_open_at) || ms(t.opened_at) > ms(ends_at)) {
      const span = `${first_open_at.toISOString()} a ${ends_at.toISOString()}`
      return ['outside_window', `fora da janela de ${window_days} dias a partir da primeira abertura (${span})`]
    }
    return null
  }

  const winner = touches.filter((t) => !ineligible(t)).sort(byPreference)[0]

  const lostTo = (t: Touch, w: Touch): [TouchReasonCode, string] => {
    if (ms(t.opened_at) < ms(w.opened_at)) return ['lost_to_later', `perdeu para toque mais recente (${w.click_id})`]
    if (CHANNEL_PRIORITY[t.source] < CHANNEL_PRIORITY[w.source]) {
      return ['lost_tie_channel', `empate de horário com ${w.click_id}: ${LABEL[w.source]} tem prioridade sobre ${LABEL[t.source]}`]
    }
    return ['lost_tie_click_id', `empate de horário e de canal com ${w.click_id}: vence o menor click_id`]
  }

  const judged = touches.map((t): JudgedTouch => {
    if (t === winner) return { ...t, outcome: 'won', reason_code: 'won', reason: `venceu: ${ORIGIN_REASON.last_touch_in_window}` }
    const [reason_code, reason] = ineligible(t) ?? lostTo(t, winner!)
    return { ...t, outcome: 'lost', reason_code, reason }
  })

  if (winner) {
    const { source, click_id, campaign_id, ref } = winner
    const reason_code = 'last_touch_in_window'
    return { origin: { source, click_id, campaign_id, ref }, reason_code, reason: ORIGIN_REASON[reason_code], window, touches: judged }
  }

  const codes = new Set(judged.map((t) => t.reason_code))
  const reason_code: OriginReasonCode = !first_open_at
    ? 'no_first_open'
    : judged.length === 0
      ? 'no_touches'
      : codes.size === 1
        ? (`all_touches_${[...codes][0]}` as OriginReasonCode)
        : 'no_eligible_touch'
  const origin = { source: 'organic' as const, click_id: null, campaign_id: null, ref: null }
  return { origin, reason_code, reason: ORIGIN_REASON[reason_code], window, touches: judged }
}
