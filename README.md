# 🧠 Morpheus v2.0

**Send a WhatsApp message. Wake up to a live site.**

Morpheus is an autonomous AI build partner. Text it an idea, it plans, codes, deploys, and sends you back a live URL — while you sleep.

---

## Stack

| Service | Role |
|---|---|
| **Anthropic Claude** | Agent brain — planning + code generation |
| **Supabase** | Database — projects, memories, ventures |
| **Upstash Redis** | Job queue |
| **WhatsApp Business API** | Your interface |
| **GitHub** | Code storage |
| **Vercel** | Primary deployment |
| **Netlify** | Fallback deployment |

---

## Setup

### 1. Clone and install
```bash
git clone https://github.com/YOUR_USERNAME/morpheus
cd morpheus
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in all values — server won't start without them
```

### 3. Run schema in Supabase
- Go to Supabase → SQL Editor
- Paste contents of `schema.sql` → Run

### 4. Set WhatsApp webhook
- Meta Developer Console → your app → WhatsApp → Webhooks
- URL: `https://your-railway-url.railway.app/webhook`
- Verify token: value of `MORPHEUS_SECRET`
- Subscribe to: `messages`

### 5. Deploy to Railway
```bash
git push origin main
# Railway auto-deploys on push
```

---

## Commands

| Message | Action |
|---|---|
| `build [idea]` | Start a build |
| `status` | See recent builds |
| `help` | Show commands |

Or just describe what you want — Morpheus figures it out.

---

## Architecture

```
WhatsApp → /webhook → routeMessage → enqueueJob → Redis queue
                                                        ↓
                                              workerLoop (3s poll)
                                                        ↓
                                              runAgent (Claude loop)
                                                        ↓
                                      bash/write_file/patch_file tools
                                                        ↓
                                              pushToGitHub → Vercel
                                                        ↓
                                              sendWhatsApp (live URL)
```
