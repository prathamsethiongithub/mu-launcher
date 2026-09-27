# Discord launch message

The actual message to send to the first 10 friends. Copy-paste the block below.

Replace `[DOWNLOAD LINK]` with the real release URL once mission 3 publishes it
(`https://github.com/prathamsethiongithub/mu-launcher/releases/latest`).

---

## Message

hey — i built a launcher for the masters' union smp. it's called ember.

it's a minecraft launcher for the smp — one click, you're in. handles your login,
downloads the right java and fabric for you, syncs the mods, puts you on the server.
you don't have to install anything but this.

**download:** [DOWNLOAD LINK]

download the `Ember-...-Setup.exe` (or the portable `.exe` if you don't want to install).

windows will try to scare you. it's unsigned (i'm not going to pretend otherwise).
to get past it, either:

- right-click the file → **properties** → tick **unblock** → ok, or
- double-click it and hit **more info** → **run anyway**.

that's it. sign in with your microsoft account (the same one you use for minecraft —
i never see your password), pick the world, hit play.

first time takes a few minutes while it grabs everything. it's worth it.

tell me what breaks. that's the point of this.

---

## Notes for the director (not part of the message)

- **Voice check.** Lowercase, no bullets-as-ads, no "blazing fast", no feature list.
  The one claim it makes ("one click, you're in") is the product's own line.
- **Honesty.** The SmartScreen warning is stated before the user hits it, and the
  unsigned status is admitted rather than glossed. Explaining it is what keeps it
  from reading as "this is sketchy".
- **The first-run wait is set up in the same message as in the app.** The app shows
  "first time takes a few minutes. it's worth it." under the play button; this
  message says the same thing. Consistent expectation is the whole fix.
- **The ask is specific and low-stakes**: "tell me what breaks." Not "let me know
  what you think" (invites polite noise) and not "report bugs via the issue tracker"
  (a chore). It's an invitation to be useful.
- **No job titles, no team, no roadmap.** One person made this and the message
  doesn't dress that up.

## Version note

This message ships with the first public release. The tag is
`v0.1.0-friends-and-family` (see truth doc 31); the artifact filenames follow
`electron-builder.yml`'s `${productName}-${version}-${arch}.${ext}` template, so the
installer is named `Ember-<version>-<arch>.exe`.
