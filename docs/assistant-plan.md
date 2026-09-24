# Claw'd, the assistant — plan

> **Superseded (2026-09-24).** The assistant became its own project,
> `clawd-assistant` (a sibling repo), aimed at office work rather than coding.
> What was decided after this draft:
> - **Separate app**, sharing the crab, both skins, voice and window code, but no
>   Claude Code hooks or Cowork toast reading.
> - **The bridge is a folder:** Claude writes JSON items into `%USERPROFILE%\Clawd\inbox`,
>   with a loopback HTTP door (port 4318, token) as the fallback.
> - **"Waiting on you" is a set of rules** the user can extend in plain English, not
>   a fixed list.
> - **Propose by default; Do it is a mode.** Do it adds a button that hands exactly
>   one suggestion to Claude, and he wears a hard hat while it's on.
> - **Voice on**, and new cuter animations (placeholders until drawn).
> - Confirmed on the work laptop: the unsigned exe runs, and scheduled tasks can
>   read Slack and Calendar.
>
> The draft below is kept for the reasoning behind these decisions.

Status: draft for discussion, 2026-09-24.

## The goal

Claw'd becomes a coworker assistant for people who don't code. At work Nat lives in
Cowork and never opens Claude Code, so a pet that reacts to Claude Code sessions has
nothing to react to. Her Claude is already connected to Asana, Gmail, Google Drive and
Slack. Claw'd should use those connections to keep all of it in one small crab:

- **Waiting on you:** who is waiting, on what, for how long, and a nudge when something
  has sat too long.
- **Reminders:** say it out loud and wave at the right time.
- **Reading things out:** "Priya asked in #launch whether the deck is final."
- **Deliveries:** a morning digest and other scheduled artifacts, delivered by him.
- **Ask Claw'd:** click him, type a short task, and Claude does it.

He stays an **always-on-top desktop pet.** Being ambient (glance at him and know) is
why the desktop version works, so this plan keeps the Tauri window and does not turn him
into a page you have to open.

**All the intelligence and all account access stay inside Claude.** The pet never holds
a token, never logs in to anything, and never calls Slack or Gmail itself. That makes it
safe, and it also makes it portable (see below).

## Constraints

1. **Portable.** It is developed on a personal laptop, handed to the work laptop through
   Slack, and later given to coworkers. Nothing may be tied to one account, email or
   machine. Each install gets set up by *that* person's Claude.
2. **Setup is done by Claude.** The handoff is a file that tells the recipient's Claude
   what to install, what to ask its user, and how to test it. The user should not need
   to be technical.
3. **Work machines are locked down.** Claude itself is approved software. An unsigned
   exe might not be (see Risks).
4. **Cowork first.** It must work without Claude Code installed. Coworkers who do use
   Claude Code keep the existing hook-driven behaviour as a bonus.

## Architecture

```
  Slack · Gmail · Asana · Drive · Calendar
                 │  (the user's claude.ai connectors)
                 ▼
  ┌─────────────────────────────┐        ┌───────────────────────────┐
  │ Claude (Cowork / desktop app)│  push  │ Claw'd (Tauri pet)         │
  │  • "clawd" skill             │ ─────▶ │  • inbox: items + ages     │
  │  • scheduled tasks           │ bridge │  • reminders, nudges       │
  │  • does the actual work      │ ◀───── │  • bubble, voice, popover  │
  └─────────────────────────────┘  ask   └───────────────────────────┘
```

This reverses the current setup. Today Claude Code *tells* the pet what is happening
through hooks. Here Claude *goes and looks* on a schedule, then pushes a summary to the
pet. When you type a task, the pet *hands it to* Claude.

### The brain: a skill plus scheduled tasks

- A **`clawd` skill** (plain files, no install) teaches Claude the job: which sources to
  check, what counts as "waiting on you", how to phrase an item for the bubble and
  voice, and how to deliver to the pet. It reads the user's preferences (channels, VIPs,
  quiet hours) from their config, so the skill itself is identical for everyone.
- **Scheduled tasks** in the user's Claude run the skill: a sweep every N minutes during
  work hours, plus a morning digest. The recipient's Claude creates these during setup.
- **"Ignored too long" is handled by the pet, not Claude.** Once an item has arrived,
  its age and the nudge timer live in the pet. That needs no extra Claude calls and
  keeps working between sweeps.

### The bridge: how Claude reaches the pet

This is the main technical decision. Phase 0 settles it on the real work laptop.

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Local MCP server** (recommended if allowed) | The pet exposes tools such as `clawd_set_inbox`, `clawd_say`, `clawd_remind` and `clawd_deliver`, packaged as a Claude desktop extension (`.mcpb`, one-click install). Scheduled tasks call them. | Typed, instant, two-way. Claude can also ask the pet things ("what's already on screen?"). | Another install. Most likely to be blocked by IT. |
| **B. Folder drop** (fallback) | The skill writes a JSON file into a folder Cowork is allowed to use (e.g. `Documents\Clawd\inbox\`). The pet watches that folder. | Nothing extra to install beyond the pet. Cowork already writes files. | One-way. Needs the folder granted to Cowork. Needs care with file formats and partial writes. |
| **C. Artifact brain** | An Artifact page with the `mcp` (connector reads) and `sample` (ask Claude) capabilities does the polling and talks to the pet through a `host:` local MCP server. | Can run with no exe at all as a fallback *face* for coworkers who can't install one. | Only works while the page is open. Loses the ambient point. |

Both A and B write the **same item format**, so the pet and the skill don't care which
transport is in use. Checked on the personal account: the Artifact runtime offers `mcp`,
`sample`, `db`, `user` and more. The work account needs to be checked separately.

### The face: what changes in the pet

- **A new inbox model** alongside the current session reducer. Each item has: `id`,
  `source` (slack/gmail/asana/drive/calendar/digest), `who`, `what` (one line), `since`,
  `due`, `urgency`, `link` (opened on click), and `spoken` (the version for voice).
- **Popover:** a "Waiting on you" list sorted by age, plus Reminders, plus Deliveries.
  Clicking a row opens the link: the Slack message, the email, the Asana task, the
  artifact.
- **Animations reuse the existing states.** Hop for something new or overdue, flag wave
  for a delivered digest, working while an Ask is running, nap when everything is clear.
  He gets a count badge.
- **Voice** reuses `voice.js`, with a privacy default: it says who and roughly what,
  never the full message body, and never during calls or quiet hours.
- **Ask Claw'd:** a text box in the popover. See the next section.
- The Claude Code hook server stays as it is. Assistant mode is a setting, and both
  modes can run at once.

### Ask Claw'd: handing work to Claude

The pet can't run Claude itself without credentials, so it hands the task over:

1. **Preferred:** open the Claude desktop app with the task prefilled, via a `claude://`
   deep link (the pet already launches `claude://code/new`). Phase 0 checks whether a
   Cowork deep link accepts a prompt.
2. **Fallback:** copy the task plus a short "use the clawd skill" preamble to the
   clipboard and open a new session.
3. **Only where Claude Code is installed:** run it headless (`claude -p`) with the
   user's connectors and show the result in the bubble.

**Acting on things:** by default Claude drafts and the user approves (a reply drafted in
Slack, an Asana task prepared). Sending happens in Claude, where the user can see it,
not from a button on the crab. Auto-send can become an opt-in per action type later.

## Portability and the handoff

Everything specific to a person lives in *their* machine and *their* Claude:

| Piece | Where it lives | Per person? |
|---|---|---|
| Pet exe | installer from GitHub Releases | no |
| `clawd` skill | `assistant/skill/` in this repo; later an org-shared skill | no |
| Preferences (VIPs, channels, quiet hours, digest time, voice on/off) | `%APPDATA%\Clawdbot\assistant.json`, written during setup | **yes** |
| Connector access | the user's own claude.ai connectors | **yes** |
| Scheduled tasks | created in the user's Claude during setup | **yes** |

**The handoff file** (`assistant/SETUP.md`) is written *for Claude to follow*. Nat
drops it into Slack, opens it with Claude on the work laptop, and says "set this up".
That Claude:

1. Checks which connectors are connected and names any that are missing.
2. Installs the pet (and the extension, if we use option A), or tells the user the one
   click they need to make.
3. Asks the user a few questions (VIPs, channels to watch, work hours, digest time,
   voice) and writes `assistant.json`.
4. Installs the skill and creates the scheduled tasks.
5. Sends a test item and confirms that Claw'd hopped.

The same file works for coworkers without changes. Nothing in the repo contains Nat's
email, workspace IDs or channel names.

## Phases

**0. Spikes on the work laptop (do first, about a day).** Each answer changes the design:
- Does the unsigned `clawdbot.exe` run at all, given SmartScreen, Smart App Control and
  IT policy?
- Can a Cowork scheduled task read Slack, Gmail and Asana through the connectors, and
  does it run when the app is closed or the laptop is asleep?
- Can Claude on that machine call a local MCP server or install a `.mcpb` extension
  (option A)? If not, can Cowork write to a folder the pet can watch (option B)?
- Does a `claude://` deep link open Cowork with a prompt prefilled?
- Which Artifact capabilities does the work account have (option C and the fallback)?

**1. Bridge and inbox in the pet.** Define the item format, add the chosen transport,
and add the inbox reducer, popover list, ages and nudge timer. Test with hand-written
items.

**2. The skill and the sweep.** Write the `clawd` skill: the "waiting on you" rules per
source, dedupe (items keep stable ids so re-sweeps don't re-announce them), and phrasing.
Add one scheduled sweep and check it against real work data.

**3. Reminders and deliveries.** Timed reminders and the morning digest as an artifact.
Claw'd waves the flag, and clicking him opens the digest.

**4. Ask Claw'd.** The text box and the handoff to Claude, with drafts approved in
Claude.

**5. Setup handoff and coworkers.** Write `SETUP.md`, run it cold on the work laptop
(as a stand-in for a fresh coworker), fix whatever it trips on, then share it.

## Risks

- **An unsigned exe on work machines.** This is the biggest risk to the whole plan. If
  IT or Smart App Control blocks it, the ambient pet is dead there. Mitigations: ask IT
  to allow it, pay for code signing, or fall back to option C (a crab in a Claude
  panel) for those users.
- **Scheduled tasks only run while Claude is running.** Sweeps pause when the app is
  closed. The pet should show "last checked 40 min ago" instead of pretending all is
  quiet. That is the same honesty rule as today's "blind" state.
- **Cost and rate limits.** A sweep across five sources every few minutes is real usage
  on the user's plan. Start at 15–30 minutes during work hours, and tune from there.
- **Work data on disk and out loud.** Items hold message snippets locally, and voice
  plays in an office. Keep snippets short, expire them, and speak only who and roughly
  what by default.
- **Connector differences between accounts.** Tool names and arguments differ per
  connector. The skill describes intent ("find unanswered DMs") and lets Claude pick the
  tools, rather than hard-coding tool calls.

## Open questions for Nat

1. Same repo, as an assistant mode of this pet (recommended, since the window, sprites,
   voice and bubble all carry over), or a separate project as the earlier handoff said?
2. What counts as "waiting on you" in each tool? For example: Slack DMs and @mentions,
   emails from VIPs with no reply, Asana tasks assigned to you and due soon.
3. How eager should he be? How often to sweep, when to nudge, and whether voice is on at
   work.
4. For Ask Claw'd, is draft-then-approve enough to start, or is there an action you want
   him to take without asking?
5. Should coworkers without the exe get the Artifact-only crab, or is the desktop pet
   the point?
