import { buildApp } from './app'
import { WINDOW_DAYS } from './attribution'

const windowDays = Number(process.env.ATTRIBUTION_WINDOW_DAYS ?? WINDOW_DAYS)
if (!(windowDays > 0)) throw new Error('ATTRIBUTION_WINDOW_DAYS deve ser um número maior que zero')

const app = buildApp({ clock: { now: () => new Date() }, windowDays })
app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).then((address) => console.log(`API ouvindo em ${address}`))
