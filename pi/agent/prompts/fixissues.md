---
description: Develop ready GitHub issues until approved
argument-hint: "[issue-list]"
---
Use the registered `developIssuesUntilApproved` workflow for the requested GitHub/GitLab issues.

- If an issue list was provided, normalize it to issue numbers and pass those numbers as the workflow's `issues` array. `$ARGUMENTS`
- If no issue list was provided, get only the numbers of open issues labeled `ready-for-agent` (for example, with `gh issue list --state open --label ready-for-agent --json number --jq '.[].number'`). Do not download issue details; the workflow fetches them.
- After the workflow is completed, If all issues completed successfully and were approved, ask the user whether to close them.
