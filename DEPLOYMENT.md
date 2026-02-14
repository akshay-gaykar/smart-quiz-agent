# Smart Quiz Agent - Production Deployment Guide

Step-by-step guide to deploy Smart Quiz Agent to production using **free** hosting services. No credit card required.

---

## Architecture Overview

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Browser    │────>│  Render.com  │────>│  Neon.tech   │
│   (Users)    │<────│  (App Server)│<────│ (PostgreSQL) │
└─────────────┘     └──────────────┘     └──────────────┘
                           │
                           v
                    ┌──────────────┐
                    │  Anthropic   │
                    │  Claude API  │
                    └──────────────┘
```

| Component | Free Service | Alternative |
|-----------|-------------|-------------|
| App Server | Render.com (free tier) | Railway.app, Fly.io |
| Database | Neon.tech (free tier) | Supabase, ElephantSQL |
| AI API | Anthropic (pay-per-use) | Required - no free alternative |

---

## Prerequisites

Before starting, make sure you have:

- [ ] GitHub account with the repository: `https://github.com/akshay-gaykar/smart-quiz-agent`
- [ ] Anthropic API key from https://console.anthropic.com
- [ ] Email address for Neon and Render signups

---

## Step 1: Set Up Free PostgreSQL Database (Neon.tech)

Neon offers a generous free tier: 0.5 GB storage, 1 project, always-on compute.

### 1.1 Create account
1. Go to https://neon.tech
2. Click **Sign Up** (use GitHub login for convenience)
3. Select the **Free** plan

### 1.2 Create a project
1. Click **New Project**
2. Project name: `smart-quiz-agent`
3. Database name: `quiz_db`
4. Region: Choose closest to your users (e.g., `US East` or `Asia Southeast`)
5. Click **Create Project**

### 1.3 Get connection string
1. After creation, you'll see a connection string like:
   ```
   postgresql://username:password@ep-xxxx.region.aws.neon.tech/quiz_db?sslmode=require
   ```
2. **Copy and save this string** — you'll need it in Step 3
3. Make sure `?sslmode=require` is at the end

---

## Step 2: Set Up Free App Hosting (Render.com)

Render offers free web services with automatic deploys from GitHub.

### 2.1 Create account
1. Go to https://render.com
2. Click **Get Started for Free**
3. Sign up with your GitHub account (`akshay-gaykar`)

### 2.2 Create a new Web Service
1. Click **New** > **Web Service**
2. Connect your GitHub repository: `akshay-gaykar/smart-quiz-agent`
3. Configure the service:

| Setting | Value |
|---------|-------|
| Name | `smart-quiz-agent` |
| Region | Same as your Neon database |
| Branch | `main` |
| Root Directory | `agent` |
| Runtime | `Node` |
| Build Command | `npm install && npx tsc` |
| Start Command | `node dist/main.js` |
| Instance Type | **Free** |

### 2.3 Set Environment Variables

In the Render dashboard, go to **Environment** tab and add:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Your Neon connection string from Step 1.3 |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `JWT_SECRET` | Any random string (e.g., `my-super-secret-jwt-key-2026`) |
| `NODE_ENV` | `production` |
| `PORT` | `3456` |

### 2.4 Deploy
1. Click **Create Web Service**
2. Render will automatically build and deploy
3. First deploy takes 2-3 minutes
4. Your app will be live at: `https://smart-quiz-agent.onrender.com`

> **Note**: Free tier services spin down after 15 minutes of inactivity. First request after sleep takes ~30 seconds to wake up.

---

## Step 3: Verify Deployment

### 3.1 Check health endpoint
```bash
curl https://smart-quiz-agent.onrender.com/health
```
Expected response:
```json
{"status": "ok", "database": "connected"}
```

### 3.2 Open the app
1. Visit `https://smart-quiz-agent.onrender.com` in your browser
2. You should see the login page
3. Register a new account or use seeded credentials:
   - admin@springfield.edu / password
   - teacher@springfield.edu / password
   - student@springfield.edu / password

### 3.3 Test key features
- [ ] Login with demo credentials
- [ ] Navigate through dashboard
- [ ] Create a topic and generate a quiz
- [ ] Take a quiz as a student
- [ ] Check leaderboard

---

## Step 4: Set Up Automatic Deploys

Render automatically redeploys when you push to `main` branch:

```bash
# Make changes locally
git add .
git commit -m "your changes"
git push origin main
```

Every push to `main` triggers a new build and deploy on Render.

---

## Production Checklist

### Security
- [ ] Change `JWT_SECRET` to a strong random string (32+ characters)
- [ ] Never commit `.env` files or API keys to git
- [ ] Verify `.gitignore` includes `.env`
- [ ] Use HTTPS (Render provides this automatically)

### Database
- [ ] Neon connection string includes `?sslmode=require`
- [ ] Migrations run on startup automatically
- [ ] Seed data only runs if no users exist (safe for re-deploys)

### Monitoring
- [ ] Check Render dashboard for deploy logs
- [ ] Check Neon dashboard for database usage
- [ ] Monitor Anthropic dashboard for API usage and costs

---

## Alternative Free Deployment Options

### Option A: Railway.app

Railway offers $5 free credit/month (enough for small apps).

1. Go to https://railway.app, sign up with GitHub
2. Click **New Project** > **Deploy from GitHub Repo**
3. Select `akshay-gaykar/smart-quiz-agent`
4. Add a PostgreSQL service (click **New** > **Database** > **PostgreSQL**)
5. Set environment variables (same as Render)
6. Set root directory to `agent`
7. Build command: `npm install && npx tsc`
8. Start command: `node dist/main.js`

### Option B: Fly.io

Fly.io offers free tier with 3 shared VMs.

1. Install Fly CLI: `brew install flyctl`
2. Sign up: `fly auth signup`
3. From `agent/` directory:
   ```bash
   fly launch --name smart-quiz-agent
   ```
4. Create a Postgres database:
   ```bash
   fly postgres create --name quiz-db
   fly postgres attach quiz-db
   ```
5. Set secrets:
   ```bash
   fly secrets set ANTHROPIC_API_KEY=your-key JWT_SECRET=your-secret
   ```
6. Deploy: `fly deploy`

### Option C: Supabase (Database Alternative)

If you prefer Supabase over Neon for PostgreSQL:

1. Go to https://supabase.com, create a project
2. Go to **Settings** > **Database** > **Connection string**
3. Copy the URI and use it as `DATABASE_URL` in Render

---

## Troubleshooting

### App won't start on Render
- Check **Logs** tab in Render dashboard
- Ensure `Root Directory` is set to `agent`
- Ensure Build Command compiles TypeScript: `npm install && npx tsc`
- Verify all environment variables are set

### Database connection errors
- Verify `DATABASE_URL` has `?sslmode=require` for Neon
- Check Neon dashboard — is the project active?
- Ensure the database name matches (`quiz_db`)

### Migrations fail
- Migrations run automatically on startup
- Check logs for specific SQL errors
- Connect to Neon SQL editor to inspect tables

### App is slow on first load
- Free tier services on Render sleep after 15 min of inactivity
- First request wakes the service (~30 seconds)
- Subsequent requests are fast
- Upgrade to paid tier ($7/month) for always-on

### AI features not working
- Verify `ANTHROPIC_API_KEY` is set correctly
- Check Anthropic dashboard for rate limits or billing issues
- AI features require a valid API key with credits

---

## Cost Summary

| Service | Free Tier Limits | Paid Upgrade |
|---------|-----------------|--------------|
| Render | 750 hours/month, sleeps after 15 min | $7/month (always-on) |
| Neon | 0.5 GB storage, 1 compute | $19/month (more storage) |
| Anthropic | Pay-per-use (~$0.003 per quiz generation) | Usage-based |

**Total monthly cost**: $0 (excluding Anthropic API usage, which is minimal for classroom use).

---

## Custom Domain (Optional)

### On Render:
1. Go to your service **Settings** > **Custom Domains**
2. Add your domain (e.g., `quiz.yourschool.edu`)
3. Add the CNAME record to your DNS provider:
   ```
   CNAME  quiz  smart-quiz-agent.onrender.com
   ```
4. Render provides free SSL automatically

---

## Team Access

### Add team members to GitHub repo:
1. Go to https://github.com/akshay-gaykar/smart-quiz-agent/settings/access
2. Click **Add people**
3. Invite team members by GitHub username or email

### Add team members to Render:
1. Go to Render dashboard > **Settings** > **Team**
2. Invite team members by email

### Add team members to Neon:
1. Go to Neon dashboard > **Settings** > **Members**
2. Invite team members by email

---

**Author:** Aryan Kale
**Last Updated:** February 2026
