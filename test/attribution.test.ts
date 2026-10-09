import { describe, expect, it } from 'vitest'
import { decideOrigin, type Source, type Touch } from '../src/attribution'

const day = (n: number, hour = 12) => new Date(Date.UTC(2026, 9, 1 + n, hour))

function touch(click_id: string, source: Source, opened_at: Date, extra: Partial<Touch> = {}): Touch {
  return {
    click_id,
    source,
    campaign_id: source === 'referral' ? null : `${source}-x`,
    ref: source === 'referral' ? 'ana' : null,
    clicked_at: opened_at,
    device_id: 'dev-1',
    opened_at,
    used_by: null,
    ...extra,
  }
}

const decide = (touches: Touch[], signed_up_at = day(5), first_open_at: Date | null = day(0)) =>
  decideOrigin({ first_open_at, signed_up_at, window_days: 7, touches })

const outcomes = (d: ReturnType<typeof decide>) =>
  Object.fromEntries(d.touches.map((t) => [t.click_id, `${t.outcome}:${t.reason_code}`]))

describe('decideOrigin: qual toque vence', () => {
  it('dois links diferentes antes do cadastro: vence o aberto por último, o outro perde para toque mais recente', () => {
    const d = decide([touch('c-camp', 'campaign', day(1)), touch('c-ref', 'referral', day(2))])

    expect(d.origin).toEqual({ source: 'referral', click_id: 'c-ref', campaign_id: null, ref: 'ana' })
    expect(d.reason_code).toBe('last_touch_in_window')
    expect(outcomes(d)).toEqual({ 'c-camp': 'lost:lost_to_later', 'c-ref': 'won:won' })
    expect(d.touches[0].reason).toBe('perdeu para toque mais recente (c-ref)')
  })

  it('empate de horário exato: indicação vence campanha pela prioridade de canal', () => {
    const d = decide([touch('c-a', 'campaign', day(2)), touch('c-z', 'referral', day(2))])

    expect(d.origin.click_id).toBe('c-z')
    expect(outcomes(d)).toEqual({ 'c-a': 'lost:lost_tie_channel', 'c-z': 'won:won' })
    expect(d.touches[0].reason).toBe('empate de horário com c-z: indicação tem prioridade sobre campanha')
  })

  it('empate de horário e de canal: vence o menor click_id em ordem lexicográfica', () => {
    const d = decide([touch('c-b', 'campaign', day(2)), touch('c-a', 'campaign', day(2))])

    expect(d.origin.click_id).toBe('c-a')
    expect(outcomes(d)).toEqual({ 'c-a': 'won:won', 'c-b': 'lost:lost_tie_click_id' })
  })

  it('o resultado não depende da ordem em que os toques chegam', () => {
    const ts = [touch('c-1', 'community', day(2)), touch('c-2', 'campaign', day(2)), touch('c-3', 'campaign', day(1))]
    const winners = [ts, [...ts].reverse(), [ts[1], ts[2], ts[0]]].map((list) => decide(list).origin.click_id)
    expect(winners).toEqual(['c-2', 'c-2', 'c-2'])
  })
})

describe('decideOrigin: janela e cadastro', () => {
  it('toque fora da janela não vence, mesmo sendo o mais recente', () => {
    const d = decide([touch('c-dentro', 'campaign', day(3)), touch('c-fora', 'referral', day(8))], day(9))

    expect(d.origin.click_id).toBe('c-dentro')
    expect(d.touches[1]).toMatchObject({
      outcome: 'lost',
      reason_code: 'outside_window',
      reason: 'fora da janela de 7 dias a partir da primeira abertura (2026-10-01T12:00:00.000Z a 2026-10-08T12:00:00.000Z)',
    })
  })

  it('a janela é explícita: começa na primeira abertura e o fim é inclusivo', () => {
    const fim = day(7)
    const d = decide([touch('c-no-limite', 'campaign', fim)], fim)

    expect(d.window).toEqual({ days: 7, starts_at: day(0), ends_at: fim })
    expect(d.origin.click_id).toBe('c-no-limite')
    const depois = decide([touch('c-1ms-depois', 'campaign', new Date(fim.getTime() + 1))], day(9))
    expect(depois.reason_code).toBe('all_touches_outside_window')
  })

  it('janela conta da primeira abertura, não do clique: clique de 10 dias atrás com app aberto depois ainda vence', () => {
    // Clicked on day -10 without the app; installed and opened for the first time on day 0 (deferred deep link).
    const antigo = touch('c-antigo', 'campaign', day(0), { clicked_at: day(-10) })
    const d = decide([antigo], day(2), day(0))

    expect(d.origin.click_id).toBe('c-antigo')
    expect(d.touches[0].outcome).toBe('won')
  })

  it('a janela limita o toque, não o cadastro: toque do dia 1 vence cadastro feito no dia 30', () => {
    const d = decide([touch('c-cedo', 'campaign', day(1))], day(30))
    expect(d.origin.click_id).toBe('c-cedo')
  })

  it('toque posterior ao cadastro não vence', () => {
    const d = decide([touch('c-antes', 'community', day(1)), touch('c-depois', 'referral', day(3))], day(2))

    expect(d.origin.click_id).toBe('c-antes')
    expect(d.touches[1]).toMatchObject({ outcome: 'lost', reason_code: 'after_signup', reason: 'posterior ao cadastro' })
  })

  it('toque já considerado em outro cadastro não vira origem de novo', () => {
    const d = decide([touch('c-usado', 'referral', day(1), { used_by: 'user-1' })])

    expect(d.origin.source).toBe('organic')
    expect(d.reason_code).toBe('all_touches_already_used')
    expect(d.touches[0].reason).toBe('já considerado no cadastro user-1')
  })
})

describe('decideOrigin: orgânico sempre tem motivo', () => {
  it('sem nenhum toque: orgânico com motivo no_touches', () => {
    const d = decide([])
    expect(d.origin).toEqual({ source: 'organic', click_id: null, campaign_id: null, ref: null })
    expect(d.reason_code).toBe('no_touches')
    expect(d.reason).toBe('nenhum link aberto neste dispositivo')
  })

  it('todos os toques fora da janela: orgânico com motivo all_touches_outside_window', () => {
    const d = decide([touch('c-1', 'campaign', day(8)), touch('c-2', 'referral', day(9))], day(10))
    expect(d.origin.source).toBe('organic')
    expect(d.reason_code).toBe('all_touches_outside_window')
  })

  it('todos os toques depois do cadastro: orgânico com motivo all_touches_after_signup', () => {
    const d = decide([touch('c-1', 'campaign', day(3))], day(2))
    expect(d.reason_code).toBe('all_touches_after_signup')
  })

  it('motivos misturados: orgânico com motivo no_eligible_touch e cada toque explica o seu', () => {
    const d = decide([touch('c-fora', 'campaign', day(8)), touch('c-depois', 'referral', day(10))], day(9))
    expect(d.reason_code).toBe('no_eligible_touch')
    expect(outcomes(d)).toEqual({ 'c-fora': 'lost:outside_window', 'c-depois': 'lost:after_signup' })
  })

  it('dispositivo sem primeira abertura: orgânico com motivo no_first_open', () => {
    const d = decide([], day(2), null)
    expect(d.reason_code).toBe('no_first_open')
    expect(d.window).toEqual({ days: 7, starts_at: null, ends_at: null })
  })
})
