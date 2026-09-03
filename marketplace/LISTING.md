# K1-Planner — Marketplace Listing Draft

Copy this into the Developer Console listing form (Distribution → Marketplace listing).

## Name
K1-Planner

## Tagline (one line, ~70 chars max)
Visual release planning, capacity, and Gantt timelines for Jira epics

## Category
Suggested: **Project Management** (secondary: Reporting)

## Pricing
Free

## Support contact
sguindi@gmail.com

## Privacy policy URL
https://sguindi.github.io/JiraVersionsPlanning/privacy-policy.html
*(Live once GitHub Pages is enabled for this repo — see note below.)*

## Short description (~150 chars, shown in search results)
Plan releases visually: drag-and-drop epic scheduling, developer capacity, dependency chains, and a real Gantt timeline — all inside Jira.

## Full description

K1-Planner turns your Jira epics and stories into a visual, drag-and-drop release plan — no spreadsheets, no separate tool.

**Three planning modes for how your team actually works:**
- **Draft** — sketch out a release with as many named "what-if" plans as you want, without touching Jira until you're ready.
- **Final** — one committed schedule per version, saved straight back to Jira due dates.
- **Epic Timeline** — zoom into a single epic and schedule its stories and subtasks in detail.

**Built for real release planning, not just a task list:**
- Drag epics and stories onto a calendar timeline; the app computes end dates from estimates and developer capacity automatically.
- Set each developer's capacity (e.g. 50% on this release) and see utilization at a glance.
- Dependency chains with visual arrows — drop one epic after another and it schedules itself behind it.
- Automatic QA/bug-fix buffer time, code freeze, and stabilization windows.
- Jira sprint boundaries and milestones shown directly on the timeline.
- Issues with real Jira due dates lock to those dates automatically, so a committed date is never silently overridden.
- One-click export to a shareable HTML timeline, or a full JSON dump of the plan for reporting.

**Everything stays in your Jira site.** K1-Planner has no external backend — it stores plan data as Jira project/issue properties and makes no calls outside Jira's own API. See the privacy policy for details.

## Screenshots
Not yet captured — see note below.

---

## Still needed before you submit

1. **Turn on GitHub Pages for this repo** (one-time, ~2 clicks) so the privacy policy URL above actually resolves:
   - The repo must be **public** (Settings → General → Danger Zone → Change visibility, if it's currently private).
   - Settings → Pages → under "Build and deployment", Source: **Deploy from a branch** → Branch: **main**, folder: **/docs** → Save.
   - Takes ~1 minute to go live after saving.
2. **Convert `marketplace/icon.svg` to a 512×512 PNG** — any online SVG→PNG converter works, or open it in a browser and screenshot it at that size.
3. **Screenshots** — 2-4 images of the app in action (Draft mode timeline, capacity panel, Gantt export are good candidates). I can help capture these via the browser if you point me at a live instance with the app installed and give the go-ahead.
4. **Review the privacy policy and description copy** — I drafted both factually from the code, but you should read them before they go live under your name.
