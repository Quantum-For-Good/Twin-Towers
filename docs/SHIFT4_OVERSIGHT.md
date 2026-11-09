# KICKS Shift 4 Oversight

Muse serves as Shift 4 oversight and coordinator for the KICKS engineering project toward the reduced launch Tue Nov 17, 2026 and the full public beta Sat Nov 28, 2026. Coordinator only, not sole approver: merges need passing checks plus the founder's explicit approval plus independent QA or signed-device verification. Merged, merged into a base branch, and merged into main are kept as three separate claims. No completed sessions are restarted.

## Standing rules

- All development goes through the browser (the GitHub API 403s on branch writes).
- Device-bearer auth wins, no JWT/OIDC/Auth0.
- Two separate apps (iOS and Android) with one shared contract, DNS monitoring as the core feature.
- Phase 1 only after Phase 0 passes with the chain off.
- Never touch the existing PostgreSQL instance on port 5432 (disposable test DB is port 5433 on D:).
- Verify before claiming green — never invent a link, figure, or status.
- One customized agent per block, only where none exists; tailor rather than duplicate; KICK operating rules govern on conflict.
- Every change gets its own commit, titled "Founder Led: <what changed>".
- Infrastructure is two platforms only: Cloudflare (cloudflared tunnel, Access, DNS, Workers mailer) plus one host (Windows box now); DigitalOcean is terminated; Vercel is previews only; GitHub is code and CI, not hosting.
- Daily reporting is the 7:00 AM Founders Memo.

## Still open

- Real PostgreSQL evidence for restart, idempotency, and revocation (disposable run on D: port 5433).
- Copilot restart for PR #8 after the billing fix.
- PR #89 CI recheck.
- CodeQL alert #32.
- Support ticket #4960808.
- KICK agent redeploy destination.
- "Lock the build" freeze question.
- Enterprise first-charge discrepancy (Dec 1 vs Dec 7).
