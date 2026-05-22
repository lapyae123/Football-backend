---
name: project-frontend
description: Frontend is the streamzone Next.js app at /Users/kyiphyuthant/Documents/Shin/Football/streamzone — admin dashboard at localhost:3000/admin
metadata:
  type: project
---

The frontend is the Next.js app located at `/Users/kyiphyuthant/Documents/Shin/Football/streamzone`.
There is no separate frontend folder inside `football-app`.

- Admin dashboard: `localhost:3000/admin`
- Backend API: `localhost:3050`

**Why:** User confirmed this explicitly — do not look for a frontend inside `football-app`.
**How to apply:** When asked to run frontend+backend, start `streamzone` (Next.js `npm run dev`) and `football-app` (Node.js `npm run dev`) together.
