# Lucid Labs team MCP

Your own Claude (Claude Code, Claude Desktop, Cursor or any MCP client) gets a live, read-only view of the
whole company: every shop's orders and customers, today's numbers, profit, Stripe, invoices, Meta / TikTok /
Google ads, support conversations, the Magic Chapter production queue, experiments, reports, and the agent bus.
It is the same data the orchestrator reads.

- **Server:** `https://mcp.159.195.252.107.nip.io/mcp` (Streamable HTTP, HTTPS)
- **Access:** one personal key per person (`lk_…`). Ștefan gives you yours privately. Never paste it into a
  chat, a document, a screenshot or a repo.
- **Read-only:** nothing can be changed, refunded, sent or deleted through it. The exceptions are
  `ask_agent`, which opens a thread for one of the company's agents (tagged with your name), and
  `todo_add` / `todo_update` on the company to-do board (no delete, no archive).
- **Logged:** every call is recorded with your name, the tool, a summary of the arguments, the row count and
  the time it took.

## Install

### Claude Code (one line)

```bash
claude mcp add --transport http --scope user lucid https://mcp.159.195.252.107.nip.io/mcp --header "Authorization: Bearer lk_YOUR_KEY"
```

Check it: `claude mcp list` should show `lucid … ✔ Connected`. Then just ask, for example
*"How are we doing today?"* or *"Find the customer maria.rossi@… and tell me what she bought."*

### Claude Desktop

Claude Desktop → Settings → Connectors → **Add custom connector** → URL
`https://mcp.159.195.252.107.nip.io/mcp`, and add the header `Authorization: Bearer lk_YOUR_KEY` if your
version offers headers.

If your Claude Desktop has no header field, use the bridge instead (needs Node.js 18+):

1. Download `bridge/lucid-mcp-bridge.mjs` from this repo, e.g. to `C:\lucid\lucid-mcp-bridge.mjs`
   (Mac: `~/lucid/lucid-mcp-bridge.mjs`).
2. Settings → Developer → **Edit Config**, and merge in `config/claude_desktop_config.json` (put your key and
   the path of the bridge file in it).
3. Restart Claude Desktop. The tools appear under the 🔌 / tools menu as **lucid**.

### Cursor

`~/.cursor/mcp.json` (or Settings → MCP → Add new server):

```json
{
  "mcpServers": {
    "lucid": {
      "url": "https://mcp.159.195.252.107.nip.io/mcp",
      "headers": { "Authorization": "Bearer lk_YOUR_KEY" }
    }
  }
}
```

### Anything else (stdio-only clients)

Run the bridge as a stdio server: command `node`, args `["/path/to/lucid-mcp-bridge.mjs"]`, environment
`LUCID_MCP_KEY=lk_YOUR_KEY`. It has no dependencies.

## How to use it

Ask in plain language; Claude picks the tools. Good first questions:

- "What are today's numbers per site? Anything unusual compared to yesterday?"
- "Show me last week's ROAS per channel and per site."
- "Which Magic Chapter films are late or held right now?"
- "What is broken right now?" (health)
- "Which Meta ads in Italy made money in the last 7 days, using our real orders, not Meta's numbers?"
- "Find everything about order cmw…" / "Find the customer with phone +39 333…"
- "What did customers write to the Magic Chapter inbox today?"
- "Which experiments are live, and how is E155 doing?"
- "Ask the support manager agent why order cmw… has no film yet."

Things to know when reading numbers:

- Money in the databases is in **minor units** (cents / bani) in the row's currency. HQ numbers (`today`,
  `kpis`, `profit`) are already in EUR.
- Database timestamps are **UTC**. A Romanian day starts at 22:00 UTC in winter (21:00 in summer).
- "Paid" means the paid column is set (`paymentConfirmedAt`, or `paidAt` on manele), not `status = 'paid'`.
- Ad accounts bill in **RON**. The ROAS you can defend is *our* revenue ÷ spend (`db_roas` in
  `meta_insights`), not the platform's own purchase value.
- A tool error on one shop means "unknown for that shop", never "zero".
- Test orders never count: on Magic Chapter add `"stripeSessionId" <> 'simulated'` and leave out our own
  addresses (qa+…, …@magic-chapter.com, example.com). HQ revenue also includes add-ons bought after payment,
  so a plain SQL sum of `"Order".amount` can be a little lower than `today` / `kpis`.

## The tools

| Tool | What it gives you | Example |
|---|---|---|
| `today` | Live today + yesterday per site: orders, paid, drafts, revenue, ad spend per channel, ROAS, conversion, profit; pace vs yesterday; HQ alerts; queue counts | "How are we doing today?" |
| `kpis` | The same KPIs for any date range, fleet and per site, with the previous period | `kpis(from: "2026-11-01", to: "2026-11-22", site: "regalo")` |
| `profit` | HQ's profit snapshot: every cost line (Meta, TikTok, Google, Stripe, Suno, OpenAI, infra) per window or range; monthly P&L | `profit(window: "month")`, `profit(monthly: true)` |
| `live_queue` | Magic Chapter factory now: render queue, workers, late films, held / failed films, stuck demos, carols; song-shop stuck queues | "Any late films?" |
| `sql` | Read-only SQL on any database (15 s, up to 2000 rows) | `sql(site: "santa", query: "SELECT language, count(*) FROM \"Order\" WHERE \"paymentConfirmedAt\" > now() - interval '1 day' GROUP BY 1")` |
| `schema` | Tables of a database, or the columns of one table | `schema(site: "regalo", table: "Order")` |
| `find_customer` | One person across every shop: orders, WhatsApp contact, support cases, HQ spend summary. By e-mail, name, phone or order id | `find_customer(query: "rossi@libero.it")` |
| `order` | Everything about one order: order, song or film + render queue, versions, every e-mail sent, codes, and the support side | `order(id: "cmwt…")` |
| `stripe` | Stripe, read-only: balance, charges, payment intents, checkout sessions, payouts, disputes, refunds, customers, payment-method configs, events… (+ search) | `stripe(resource: "disputes")`, `stripe(resource: "charges", search: "email:'a@b.com'")` |
| `invoices` | Paid vs invoiced per shop (with the orders missing an invoice); Oblio invoices per series; HQ accounting; OSS / VAT view | `invoices(source: "oblio", series: "MCIT")`, `invoices(source: "oss")` |
| `meta_accounts` | Every Meta ad account and whether it is readable right now | |
| `meta_insights` | Meta ads per account / campaign / ad set / ad: spend, CPM, CTR, CPC, Meta purchases, and **our real revenue and ROAS** per ad / campaign | `meta_insights(account: "regalo", level: "ad", from: "2026-11-16")` |
| `tiktok_report` | TikTok ads per campaign / ad from BOTH advertisers (the old song-shop one via the API, with Complete Payment value; and, since mid-November, the one every live campaign runs on, via HQ's Ads Manager copy) + spend per brand + TikTok-attributed DB revenue | `tiktok_report(brand: "santa")` |
| `google_ads` | Google Ads per site and campaign (from the daily push into HQ) | |
| `support_threads` | Support conversations: live Gmail inboxes (every shop, Magic Chapter, the company inbox), WhatsApp, Sofia chat / Messenger / Instagram | `support_threads(channel: "email", who: "a@b.com", days: 30)`, then `support_threads(channel: "email", inbox: "santa", thread: "<id>")` |
| `escalations` | Support cases the bot could not finish (open by default), with notes and the owner-only flag | `escalations(brand: "regalo")` |
| `health` | What is broken: HQ's failing / warning / stale checks + the daily front-end error backlog | |
| `experiments` | The experiment registry (E1…), one experiment in full with HQ's live result | `experiments(id: "E155")` |
| `reports` | The orchestrator's written reports and plans (synced from `D:/lucid-ops` every 15 min): list, read, search | `reports(action: "search", query: "Black Friday")` |
| `owner_relay` | Questions the agents are waiting on Ștefan for | |
| `agent_threads` | The agent bus: threads (list / one in full) and the agent roster | `agent_threads(agents: true)` |
| `ask_agent` | Open a bus thread to an agent (or the orchestrator) | `ask_agent(agent: "suport.manager", title: "…", text: "…")` |
| `todo_list` | The company to-do board (HQ «De făcut»): tickets, status, who, due day | `todo_list(status: "todo", assignee: "razvan")` |
| `todo_add` | Add a task to the board (lands in «De făcut», the team is notified) | `todo_add(title: "…", description: "…", priority: 2, assignee: "edi")` |
| `todo_update` | Change a task: status backlog/todo/doing/done, priority, assignee, due day, steps | `todo_update(id: "…", status: "done")` |
| `hq` | Any HQ dashboard screen as data (GET only) | `hq(path: "/api/hq/retention?from=2026-11-01&to=2026-11-22")` |

**Databases (`sql` / `schema` sites):** `manele` (also HQ's own tables: ProfitSnapshot, GoogleAdsDay, Bus*,
HealthCheckResult…), `melodie`, `regalo`, `cadeau`, `cancion`, `songgift`, `geschenk`, `podarunek`, `doro`,
`hediye`, `tucancion`, `santa` (Magic Chapter), `agent` (support hub / Sofia: EscalationCase, WaMessage,
ActionLog, IssueFix…), `clubhub` (Gifter Club), `mcp` (this server's audit log).

## Limits and safety

- SQL runs as a dedicated read-only database role inside a read-only transaction; 15-second timeout; 2000 rows max.
- No tool returns passwords, API keys, tokens or environment values (credential columns and private page
  tokens come back as `[hidden]`).
- Personal data of customers is visible (company access). Treat it as such: don't paste it into public places.
- Rate limit: 120 calls per minute and 8 at the same time per person.
- Lost or leaked key? Tell Ștefan: he rotates it in seconds and the old one stops working.

## What is in this repo

```
README.md                         this file
config/claude_desktop_config.json Claude Desktop config (bridge version)
bridge/lucid-mcp-bridge.mjs       stdio -> HTTPS bridge, no dependencies
server/                           the server's source (TypeScript, @modelcontextprotocol/sdk), for reading
deploy/                           how it runs on the box (Docker behind the existing HTTPS proxy)
admin/                            owner-only scripts: keys, file sync, end-to-end test
```

No secrets, keys or key hashes are stored in this repo.

## For the owner (admin)

- Keys: `node admin/keys.mjs list | add <person> | rotate <person> | revoke <person>`. Plain keys live only in
  `D:/lucid-ops/migration/env/mcp-team-keys.txt` on the owner's PC; the box gets sha256 hashes only and picks
  up changes within seconds, no restart.
- Deploy: `sh deploy/deploy.sh` (code) or `sh deploy/deploy.sh --secrets` (also re-copies credentials from
  the HQ, Magic Chapter and support containers after a token rotation).
- Test every tool end to end: `node admin/test-tools.mjs` (`--with-ask` also opens one bus thread).
- Audit: `sql(site: "mcp", query: "SELECT * FROM audit_log ORDER BY at DESC LIMIT 100")`.
