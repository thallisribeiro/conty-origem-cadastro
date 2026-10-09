# Origem do cadastro no app

API que decide de qual link (campanha, indicação ou comunidade) veio cada cadastro no app da Conty, sem depender de referrer.
Cada cadastro guarda a origem, o motivo e todos os toques que concorreram, com o porquê de cada um ter vencido ou perdido.

Comece a leitura por `decideOrigin` em [`src/attribution.ts`](src/attribution.ts): é a regra inteira, numa função pura.

## Como rodar e testar

Node 20 ou mais novo.

```bash
npm ci
npm test            # vitest: 32 testes
npm run typecheck   # tsc --noEmit
npm start           # API em http://localhost:3000 (PORT e ATTRIBUTION_WINDOW_DAYS opcionais)
```

## O contrato

```
link (/r)  ->  app abre (first-open)  ->  app recebe o link (touches)  ->  cadastro (signups)  ->  auditoria
```

**1. O que viaja no link.** Tudo vai na URL. O servidor gera o `click_id` no redirect.

| Canal | Link |
|---|---|
| Campanha | `https://appconty.com/r?src=campaign&cid=black-friday-2026` |
| Indicação | `https://appconty.com/r?src=referral&ref=ana_criadora` |
| Comunidade | `https://appconty.com/r?src=community&cid=discord-criadores` |

`GET /r` grava o clique (`click_id` UUID aleatório, canal, `cid` ou `ref`, `clicked_at`) e responde `302` para `https://appconty.com/app/open?click_id=<click_id>`.
Essa URL é universal link / App Link: com o app instalado, o sistema abre o app com ela. Sem o app, a página manda para a loja carregando o mesmo `click_id` (no Android, `referrer=click_id%3D...` do Install Referrer), e o app lê o valor na primeira abertura (deferred deep link).

**Webview sem referrer:** nada aqui lê o header `Referer`. O `click_id` vai na URL do redirect, e o app o recebe pela URL que o abriu ou pelo install referrer da loja. O webview pode descartar o header à vontade.

**2. O que o app grava na primeira abertura.** O app gera um `device_id` (install id) uma vez por instalação e chama `POST /devices/:deviceId/first-open` a cada abertura. A primeira chamada grava `first_open_at` com a hora do servidor (201). As outras devolvem o mesmo valor sem mudar nada (200, `already_recorded: true`).

**3. O toque.** Sempre que o app recebe um link, chama `POST /devices/:deviceId/touches` com `{ "click_id": "..." }`. O servidor liga o clique ao dispositivo e grava `opened_at`, a hora em que o app recebeu o link.

- `click_id` desconhecido: 404. O app não consegue inventar origem.
- Mesmo `click_id` de novo no mesmo dispositivo: 200 com `duplicate: true`, sem criar segundo toque.
- Mesmo `click_id` em outro dispositivo: 409. Um clique vira no máximo um toque.

**4. O cadastro.** O serviço de contas chama `POST /signups` com `{ "user_id", "device_id", "signed_up_at"? }`. A API lê os toques do dispositivo, aplica a regra, grava a decisão congelada e marca como usados por esse cadastro os toques que concorreram. Um toque posterior ao cadastro aparece na auditoria, mas continua livre para um próximo cadastro no mesmo aparelho.
`signed_up_at` é opcional (padrão: agora). Serve para o serviço de contas mandar a hora real da criação da conta, para que um link aberto entre a criação e a chamada não conte. Precisa ser ISO 8601 com hora e fuso (`2026-10-09T18:08:08Z`), para o fuso do servidor nunca mudar o instante. Data no futuro ou fora desse formato: 400.

**5. Auditoria.** `GET /signups/:userId/attribution` devolve a decisão gravada, sem recalcular: origem, motivo, janela usada e todos os toques considerados, cada um com `outcome` (`won`/`lost`), `reason_code` e `reason` em português.

## A regra (uma função: `decideOrigin`)

Um toque é **elegível** quando:

1. não foi considerado por outro cadastro (`already_used`);
2. `opened_at <= signed_up_at`. Toque posterior ao cadastro nunca conta (`after_signup`);
3. `opened_at` está dentro da janela `[first_open_at, first_open_at + 7 dias]`, com as duas pontas inclusivas (`outside_window`).

Entre os elegíveis vence o **último toque**: maior `opened_at`. Empate no mesmo milissegundo: vence o canal de maior prioridade, **indicação > campanha > comunidade** (`CHANNEL_PRIORITY`). Persistindo o empate, vence o **menor `click_id`** em ordem lexicográfica simples. O resultado não depende da ordem em que os toques chegam.

Os perdedores elegíveis recebem `lost_to_later` ("perdeu para toque mais recente"), `lost_tie_channel` ou `lost_tie_click_id`.

**Sem toque elegível, a origem é `organic` com motivo**, nunca null:

| `reason_code` | Quando |
|---|---|
| `no_touches` | nenhum link aberto no dispositivo |
| `all_touches_outside_window` | todos fora da janela |
| `all_touches_after_signup` | todos depois do cadastro |
| `all_touches_already_used` | todos já considerados em outro cadastro |
| `no_eligible_touch` | motivos misturados (cada toque traz o seu) |
| `no_first_open` | dispositivo sem primeira abertura registrada. A atribuição não bloqueia o cadastro. |

### Decisões

- **A janela conta da primeira abertura, não do clique.** O tempo do toque é `opened_at`, a hora em que o app recebeu o link. Quem clicou há 10 dias e só instalou hoje recebe o clique na primeira abertura e ele vale. `clicked_at` fica guardado só para auditoria. A janela tem 7 dias (`WINDOW_DAYS`, ajustável por `ATTRIBUTION_WINDOW_DAYS`), e cada decisão grava `days`, `starts_at` e `ends_at`.
- **A janela limita o toque, não o cadastro.** Um toque dentro da janela continua valendo se o cadastro vier depois dela. Se o time quiser que a origem expire para cadastro tardio, basta uma condição a mais em `decideOrigin`.
- **Prioridade no empate:** indicação é uma pessoa específica trazendo outra, campanha é mídia comprada e comunidade é o canal mais difuso. O `click_id` só existe para o empate nunca depender da ordem de chegada.
- **Clique repetido:** abrir o mesmo link duas vezes gera dois `click_id` (antes do app não há como saber que é a mesma pessoa, e aqui não se usa fingerprint). Os dois aparecem na auditoria, um vence e a origem continua sendo uma só. O mesmo `click_id` reenviado é idempotente. Cada toque concorre em uma decisão só: um segundo cadastro no mesmo aparelho não reaproveita o clique.
- **Cadastro idempotente:** o mesmo `user_id` de novo devolve a decisão gravada (200). Com outro `device_id`, devolve 409.
- **Decisão congelada:** a auditoria mostra o que foi decidido na hora, com a janela daquele momento. Mudar a configuração depois não reescreve a história.

### O que um banco real garantiria

Os dados ficam em memória atrás da interface `Store` ([`src/store.ts`](src/store.ts)). Em Postgres:

- `devices(device_id PK)`: primeira abertura com `INSERT ... ON CONFLICT (device_id) DO NOTHING` seguido de leitura. Duas aberturas simultâneas não sobrescrevem `first_open_at`.
- `touches(click_id UNIQUE, device_id indexado)`: a constraint garante que o mesmo clique não vira dois toques nem vai para dois dispositivos.
- `signups(user_id PK)`: o cadastro roda numa transação, com `SELECT ... FROM touches WHERE device_id = $1 FOR UPDATE`, decisão, `INSERT` do cadastro e `UPDATE touches SET used_by = $1 WHERE ... AND used_by IS NULL`. Dois cadastros simultâneos no mesmo aparelho ficam serializados pelo lock. O mesmo `user_id` em paralelo bate na PK, e a segunda chamada relê e devolve a decisão gravada.
- Em memória vale o mesmo, porque o handler lê os toques e grava o cadastro sem nenhum `await` no meio.

## Exemplos (executados contra a API local)

Link de campanha:

```bash
curl -si "http://localhost:3000/r?src=campaign&cid=black-friday-2026"
```
```
HTTP/1.1 302 Found
location: https://appconty.com/app/open?click_id=15954152-afbe-4da0-9ae6-e626b335be6b
```

Primeira abertura (a segunda chamada devolve o mesmo `first_open_at` com `already_recorded: true`):

```bash
curl -s -X POST http://localhost:3000/devices/inst-7f3a9c/first-open
```
```json
{"device_id":"inst-7f3a9c","first_open_at":"2026-10-09T18:08:06.663Z","already_recorded":false}
```

O app recebeu o link da campanha e, depois, o de indicação (`/r?src=referral&ref=ana_criadora`):

```bash
curl -s -X POST http://localhost:3000/devices/inst-7f3a9c/touches -H 'content-type: application/json' -d '{"click_id":"15954152-afbe-4da0-9ae6-e626b335be6b"}'
```
```json
{"touch":{"click_id":"15954152-afbe-4da0-9ae6-e626b335be6b","source":"campaign","campaign_id":"black-friday-2026","ref":null,"clicked_at":"2026-10-09T18:08:06.308Z","device_id":"inst-7f3a9c","opened_at":"2026-10-09T18:08:06.909Z","used_by":null},"duplicate":false}
```

Cadastro (a mesma resposta volta em `GET /signups/user-42/attribution`):

```bash
curl -s -X POST http://localhost:3000/signups -H 'content-type: application/json' -d '{"user_id":"user-42","device_id":"inst-7f3a9c"}'
```
```json
{
  "user_id": "user-42",
  "device_id": "inst-7f3a9c",
  "signed_up_at": "2026-10-09T18:08:08.013Z",
  "decided_at": "2026-10-09T18:08:08.013Z",
  "origin": { "source": "referral", "click_id": "18f3bcf9-a8e2-4201-979e-27f64a571122", "campaign_id": null, "ref": "ana_criadora" },
  "reason_code": "last_touch_in_window",
  "reason": "toque mais recente dentro da janela e antes do cadastro",
  "window": { "days": 7, "starts_at": "2026-10-09T18:08:06.663Z", "ends_at": "2026-10-16T18:08:06.663Z" },
  "touches": [
    {
      "click_id": "15954152-afbe-4da0-9ae6-e626b335be6b", "source": "campaign", "campaign_id": "black-friday-2026", "ref": null,
      "clicked_at": "2026-10-09T18:08:06.308Z", "device_id": "inst-7f3a9c", "opened_at": "2026-10-09T18:08:06.909Z",
      "outcome": "lost", "reason_code": "lost_to_later",
      "reason": "perdeu para toque mais recente (18f3bcf9-a8e2-4201-979e-27f64a571122)"
    },
    {
      "click_id": "18f3bcf9-a8e2-4201-979e-27f64a571122", "source": "referral", "campaign_id": null, "ref": "ana_criadora",
      "clicked_at": "2026-10-09T18:08:07.155Z", "device_id": "inst-7f3a9c", "opened_at": "2026-10-09T18:08:07.538Z",
      "outcome": "won", "reason_code": "won",
      "reason": "venceu: toque mais recente dentro da janela e antes do cadastro"
    }
  ]
}
```

Cadastro sem nenhum link:

```json
{
  "user_id": "user-43",
  "device_id": "inst-b2c1",
  "signed_up_at": "2026-10-09T18:08:08.783Z",
  "decided_at": "2026-10-09T18:08:08.783Z",
  "origin": { "source": "organic", "click_id": null, "campaign_id": null, "ref": null },
  "reason_code": "no_touches",
  "reason": "nenhum link aberto neste dispositivo",
  "window": { "days": 7, "starts_at": "2026-10-09T18:08:08.552Z", "ends_at": "2026-10-16T18:08:08.552Z" },
  "touches": []
}
```

Erros de validação da API, no formato `{ "error": "..." }` (JSON malformado cai no erro padrão do fastify, em inglês):

```json
{"error":"ref é obrigatório para src=referral (letras, números, _ ou -, até 64)"}
{"error":"dispositivo sem primeira abertura registrada; chame POST /devices/:deviceId/first-open antes"}
{"error":"clique já registrado em outro dispositivo"}
{"error":"signed_up_at deve ser data ISO 8601 que não esteja no futuro"}
```

## Critério de avaliação → teste que cobre

| Critério | Teste |
|---|---|
| Cadastro sem origem fica orgânico com motivo gravado | `test/attribution.test.ts`: "sem nenhum toque: orgânico com motivo no_touches", "todos os toques fora da janela: orgânico com motivo all_touches_outside_window", "todos os toques depois do cadastro: orgânico com motivo all_touches_after_signup", "motivos misturados: orgânico com motivo no_eligible_touch e cada toque explica o seu", "dispositivo sem primeira abertura: orgânico com motivo no_first_open"; `test/api.test.ts`: "cadastro sem toque fica orgânico com motivo gravado e consultável depois" |
| O mesmo clique não cria duas origens | `test/api.test.ts`: "mesmo link aberto duas vezes: dois click_id, dois toques na auditoria e uma origem só", "o mesmo clique reportado duas vezes pelo app cria um toque só", "o mesmo clique não pode virar toque em outro dispositivo", "segundo cadastro no mesmo dispositivo não reaproveita o clique que já virou origem", "cadastro repetido com o mesmo user_id devolve a decisão gravada, sem decidir de novo"; `test/attribution.test.ts`: "toque já considerado em outro cadastro não vira origem de novo" |
| Toque fora da janela não vence | `test/attribution.test.ts`: "toque fora da janela não vence, mesmo sendo o mais recente"; `test/api.test.ts`: "toque fora da janela pela API: link aberto 8 dias depois da primeira abertura não vence" |
| Toque posterior ao cadastro não vence | `test/attribution.test.ts`: "toque posterior ao cadastro não vence"; `test/api.test.ts`: "cadastro informado com horário anterior ao toque: toque posterior ao cadastro não vence", "link aberto depois do cadastro não muda a origem gravada", "toque posterior a um cadastro não fica preso a ele e pode ser a origem do próximo cadastro no aparelho" |
| Janela explícita, medida da primeira abertura | `test/attribution.test.ts`: "a janela é explícita: começa na primeira abertura e o fim é inclusivo", "janela conta da primeira abertura, não do clique: clique de 10 dias atrás com app aberto depois ainda vence", "a janela limita o toque, não o cadastro: toque do dia 1 vence cadastro feito no dia 30"; `test/api.test.ts`: "janela medida da primeira abertura: clique de 10 dias atrás entregue na primeira abertura vence" |
| Dá para auditar a origem | `test/api.test.ts`: "link de campanha e de indicação antes do cadastro: a resposta lista os dois toques e o motivo de cada um" |
| Entrega: dois links | `test/attribution.test.ts`: "dois links diferentes antes do cadastro: vence o aberto por último, o outro perde para toque mais recente" |
| Entrega: empate de horário | `test/attribution.test.ts`: "empate de horário exato: indicação vence campanha pela prioridade de canal", "empate de horário e de canal: vence o menor click_id em ordem lexicográfica", "o resultado não depende da ordem em que os toques chegam"; `test/api.test.ts`: "empate de horário pela API: indicação vence campanha aberta no mesmo instante" |
| Contrato do link e primeira abertura | `test/api.test.ts`: "o link carrega tudo na URL: o servidor gera click_id e redireciona para o app sem depender de referrer", "primeira abertura é gravada uma vez só: aberturas seguintes não mudam first_open_at" |

## O que ficou de fora

- Banco real com as constraints e a transação descritas acima.
- Autenticação: as chamadas do app (`first-open`, `touches`) e do serviço de contas (`signups`) entram sem credencial. Em produção, o app manda um token de instalação e o cadastro só aceita chamada interna.
- A página `/app/open` que manda para a loja, e o deferred deep link no iOS, que não tem install referrer: o caminho seria a área de transferência com consentimento ou um "abrir no app" depois de instalar.
- Filtro de bots e limite de taxa no `/r`. Do jeito que está, um robô infla cliques, embora não consiga criar origem sem um app que registre o toque.
- Relatório agregado de cadastros por origem. Hoje cada cadastro tem a sua decisão, e falta o `GROUP BY`.

## Uso de IA

Feito com IA: todo o código, os testes e este texto foram escritos pelo Claude Code (modelo Claude Opus 5.5), um agente de programação, a partir do enunciado. O Thallis escolheu a abordagem de trabalho e decidiu enviar.

Revisado: cada critério de "Como avaliamos" e cada item de "Entrega" tem um teste nomeado (tabela acima); suíte e typecheck rodados num clone limpo; os exemplos de request/response deste README foram executados contra a API rodando localmente. Antes do envio, uma segunda passada de agente releu o diff contra o enunciado.
