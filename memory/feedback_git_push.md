---
name: No git push without permission
description: User wants to test locally before pushing — never push to git without explicit approval
type: feedback
---

Do not run `git push` unless the user explicitly says "push" or "push to git".
Make and test changes locally first, commit only when asked.

**Why:** User was burned by changes going live before local testing was done.
**How to apply:** After making code changes, stop at commit (or just file edits). Ask user to test locally, wait for go-ahead before pushing.
