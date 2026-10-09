import type { Click, Decision, Touch } from './attribution'

export interface Device {
  device_id: string
  first_open_at: Date
}

/** The decision is frozen at signup time; reading it later never recomputes. */
export interface Signup extends Decision {
  user_id: string
  device_id: string
  signed_up_at: Date
  decided_at: Date
}

/** Persistence boundary. What a real database enforces for each method is in the README. */
export interface Store {
  saveClick(click: Click): void
  findClick(click_id: string): Click | undefined
  /** Inserts only when absent: first_open_at is written once and never changes. */
  recordFirstOpen(device_id: string, at: Date): { device: Device; created: boolean }
  findDevice(device_id: string): Device | undefined
  /** A click becomes at most one touch (unique click_id). */
  findTouch(click_id: string): Touch | undefined
  addTouch(touch: Touch): void
  touchesOf(device_id: string): Touch[]
  findSignup(user_id: string): Signup | undefined
  /** Saves the signup and marks the touches it judged as used by it, all or nothing. */
  saveSignup(signup: Signup, judgedClickIds: string[]): void
}

export class MemoryStore implements Store {
  private clicks = new Map<string, Click>()
  private devices = new Map<string, Device>()
  private touches = new Map<string, Touch>()
  private signups = new Map<string, Signup>()

  saveClick(click: Click) {
    this.clicks.set(click.click_id, click)
  }

  findClick(click_id: string) {
    return this.clicks.get(click_id)
  }

  recordFirstOpen(device_id: string, at: Date) {
    const existing = this.devices.get(device_id)
    if (existing) return { device: existing, created: false }
    const device = { device_id, first_open_at: at }
    this.devices.set(device_id, device)
    return { device, created: true }
  }

  findDevice(device_id: string) {
    return this.devices.get(device_id)
  }

  findTouch(click_id: string) {
    return this.touches.get(click_id)
  }

  addTouch(touch: Touch) {
    if (this.touches.has(touch.click_id)) throw new Error(`touch already exists for click ${touch.click_id}`)
    this.touches.set(touch.click_id, touch)
  }

  // ponytail: full scan; a real database indexes touches by device_id.
  touchesOf(device_id: string) {
    return [...this.touches.values()].filter((t) => t.device_id === device_id)
  }

  findSignup(user_id: string) {
    return this.signups.get(user_id)
  }

  // Synchronous, so no request interleaves between the caller reading touches and this write.
  saveSignup(signup: Signup, judgedClickIds: string[]) {
    if (this.signups.has(signup.user_id)) throw new Error(`signup already exists for ${signup.user_id}`)
    this.signups.set(signup.user_id, signup)
    for (const id of judgedClickIds) this.touches.get(id)!.used_by = signup.user_id
  }
}
