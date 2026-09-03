# K1-Planner — Privacy Policy

*Last updated: 2026-09-03*

## Summary

K1-Planner is a Jira Cloud app for visual release and capacity planning. It reads and writes data only within your own Jira site, using Atlassian's own APIs. It does not send data to any server operated by us or by any third party, does not use analytics or tracking, and does not sell or share data with anyone.

## What data the app accesses

To do its job, K1-Planner reads the following data from your Jira site, using the permissions (scopes) you grant when installing it:

- **Projects, issues, and their fields** — epics, stories, subtasks, statuses, assignees, estimates, due dates, fix versions, sprints, and issue change history — to build the planning views.
- **User profile information** — display names of assignees, for showing who's assigned to what.

The app does not access data outside the Jira site it's installed on, and does not access Confluence, Bitbucket, or any other Atlassian product.

## What data the app stores, and where

K1-Planner stores its own planning data (draft plans, developer capacity settings, milestones, and similar app-specific configuration) as **Jira entity properties** — a storage mechanism provided by Atlassian, attached directly to your Jira projects and issues. This data:

- Lives inside your Jira site's own Atlassian-hosted infrastructure, in the same data residency region as the rest of your Jira data.
- Is never copied to, or processed by, any external server. K1-Planner has no backend of its own — it runs entirely as a Forge app on Atlassian's platform and a browser-side UI.
- Is deleted when you uninstall the app or delete the underlying Jira project/issue.

## Third parties

K1-Planner does not integrate with, or send data to, any third-party service, analytics provider, or advertising network. There is no external network access in the app at all — every request it makes goes to Jira's own REST API on your site.

## Changes to this policy

If what the app accesses or stores changes in a future version, this page will be updated and the "Last updated" date above will change accordingly.

## Contact

Questions about this policy or the app's data handling: **sguindi@gmail.com**
