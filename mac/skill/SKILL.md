---
name: customize-walkie
description: Customize the Walkie iPhone app for this Mac by editing ~/.walkie/walkie.json (quick asks, project names, hidden projects). Use when the user asks to add, change or remove a Walkie quick ask, rename or hide a project in Walkie, or otherwise personalize Walkie.
---

# Customize Walkie

Walkie (the iPhone client for the coding agents on this Mac) has no settings screen for
personalization. It reads one file, `~/.walkie/walkie.json`, and picks up changes within a second.
You are the editor. Read the file first (it may not exist), change only what was asked, keep it
valid JSON, and write it back whole.

```json
{
  "asks": [
    { "title": "Run the tests", "text": "Run the test suite and fix anything that fails. Tell me what you changed." }
  ],
  "projects": {
    "/Users/me/projects/app": {
      "name": "The App",
      "asks": [ { "title": "Ship it", "text": "Commit what's done with a clear message and push." } ],
      "hidden": false
    }
  }
}
```

- `asks`: quick asks shown when starting any conversation. `title` ≤ 60 characters is what the
  button says; `text` (≤ 4,000) is the message that gets sent. Up to 12 are shown.
- `projects.<absolute path>`: `name` replaces the folder name in Walkie; `asks` are quick asks shown
  only for that project (they come before the global ones); `hidden: true` keeps the project out
  of Walkie's lists.
- Walkie ignores anything it doesn't understand, field by field, so a typo never breaks the rest.
- Don't put secrets in this file. It's plain JSON on this Mac.

When done, say what you added in one line and that it's already live on the phone.
