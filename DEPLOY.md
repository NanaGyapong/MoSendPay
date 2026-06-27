# Deploying MosendPay to a live URL (Render)

This gets MosendPay onto a public HTTPS link with a persistent SQLite database
(data survives restarts via a Render persistent disk).

## What's already done for you

The code is deployment-ready:
- `PORT` is read from the environment (Render assigns one).
- `SQLITE_PATH` points at a persistent disk on Render (`/data/mosendpay.db`).
- The server runs DB migrations automatically on startup.
- It serves a landing page (`/`), the dashboard (`/dashboard`), and hosted
  checkout (`/checkout/:id`) all from the same origin, so no URL hardcoding.
- `render.yaml` provisions the web service + persistent disk automatically.

## Step 1 — Push the code to GitHub

From the project folder in Git Bash:

```bash
cd ~/Downloads/MosendPay.app/mosendpay   # adjust to your path
git init
git add -A
git commit -m "MosendPay: deploy-ready"
git branch -M main
git remote add origin https://github.com/NanaGyapong/MoSendPay.git
git push -u origin main
```

If git asks you to sign in, use your GitHub username and a Personal Access Token
as the password (GitHub → Settings → Developer settings → Personal access tokens →
Tokens (classic) → generate one with `repo` scope).

## Step 2 — Deploy on Render

1. Go to https://render.com and sign up / log in (you can sign in with GitHub).
2. Click **New** → **Blueprint**.
3. Connect your GitHub and pick the **MoSendPay** repo.
4. Render reads `render.yaml` and shows a `mosendpay` web service with a 1 GB disk.
5. Click **Apply**. Render installs, builds, and starts the app.
6. After a few minutes you get a URL like `https://mosendpay.onrender.com`.

> The `starter` plan is required for a persistent disk (the free plan has no disk,
> so SQLite data would reset on restart). If you want free first and don't mind the
> database resetting occasionally, change `plan: starter` to `plan: free` and remove
> the `disk:` block in `render.yaml`.

## Step 3 — Use your live link

- Landing page: `https://YOUR-APP.onrender.com/`
- Merchant dashboard: `https://YOUR-APP.onrender.com/dashboard`
- Health check: `https://YOUR-APP.onrender.com/health`

Create a merchant from the dashboard, make a checkout session via the API (or the
dashboard's simulate button), and open the returned `/checkout/cs_...` URL — now a
public link you can send to anyone to try a payment.

## Notes

- First request after idle may be slow on small plans (the service spins up).
- This runs on the `mock` PSP. To take real money you implement a Hubtel/Paystack
  provider in `src/modules/payments/psp.js` and set `PSP_PROVIDER` — and you need a
  Bank of Ghana licence or a licensed partner.
- For real scale, switch `SQLITE_PATH` to a hosted Postgres via `DATABASE_URL`
  (requires the Postgres adapter — a later step).
