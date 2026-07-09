# White-glove validation runbook

The goal of this runbook is to answer one question: **do people who actually
drown in high-volume WhatsApp groups reach for this tool on their own, more than
once, without being reminded?**

That is the core thesis of the product. Everything else (open-source stars,
"cool project" comments, dev interest) is a different, weaker signal. This track
is the real one.

You run it by hand-installing the tool for 3-5 real users and watching what they
do for two weeks. You have to hand-install because the target users are, by
definition, the non-technical people who can't run `uv sync` themselves. That is
not a detour; it is the mechanism.

---

## The one metric that matters

**Unprompted opens.** Did the user open the sidebar and ask the agent something
because *they* wanted to know, not because you asked them to try it.

Everything else is noise. "It's cool" is noise. "I used it when you texted me to"
is noise (politeness bias). A person opening it on a Tuesday because they wondered
what they missed in the finance group is the entire signal.

### Keep / kill criteria (decide this BEFORE you start)

Write your threshold down now so you can't move the goalposts later.

- **Strong signal:** 2+ of 5 users open it unprompted in week 2 (the second week,
  after novelty has worn off). Keep going, invest more.
- **Weak signal:** 1 of 5. Ambiguous. Talk to that one person, understand why they
  came back, consider whether the others hit a specific wall.
- **Kill / pivot signal:** 0 of 5 open it unprompted in week 2. The pain is too
  soft to build a product on as-is. This is the outcome the whole exercise exists
  to detect early, before you sink months in. Do not rationalize it away.

---

## Step 1: Recruit the right 5 people

You need people with the actual pain, not people who like you.

**Recruit if they:**
- Are in several high-volume WhatsApp groups (finance, job/networking, community,
  spirituality, deal/alerts groups) that are genuinely active.
- Have muted or stopped opening at least one of those groups because it's too noisy.
- Have said something like "I can't keep up with that group" in real life.

**Do NOT recruit:**
- Developers or tinkerers. They'll validate the trust/self-hosting angle (that's
  the other track) and they'll be too forgiving of setup friction.
- Close friends who'll use it to be nice to you. Politeness poisons the metric.
- People who barely use WhatsApp, or who are only in 1-2 quiet groups. No pain,
  no test.

**Where to find them:** your own WhatsApp groups are the fastest source. Post in a
group you're already in ("building a thing that catches what you miss in busy
groups, want to try it?"), or ask people 1:1 who've complained about group noise.

Aim for 5 so that if 2 flake you still have 3.

---

## Step 2: How to pitch it to them (pain framing, not trust framing)

These users do not care that the code is auditable or that it can run on a local
model. That pitch is for the dev launch. To a real user, lead with the pain:

> "You know how [that group] has like 200 messages a day and you've basically
> given up on it? I built a thing where you can just ask 'did I miss anything
> important this week' and it reads it for you. Want me to set it up on your
> laptop? Takes 15 minutes and I'll do it with you."

Then be honest about what it does, because they're letting an AI read their private
messages and you want their real trust, not a surprise later:

> "It runs on your own machine. Every time it wants to read a chat it asks you
> first, on the page, and you can say no. One thing to know: voice notes and videos
> get sent to Google's AI to transcribe them, then deleted. Text can stay fully on
> your machine. That okay with you?"

If that honesty scares someone off, that's real data too. Better to learn it now.

---

## Step 3: Per-user setup checklist (the white-glove part)

Do this over a screen-share or in person. The user should never touch a terminal
alone. Run the same steps for each person and check them off.

- [ ] **Chrome + WhatsApp Web working.** They're already logged into
      web.whatsapp.com in Chrome.
- [ ] **Load the extension.** `chrome://extensions` → Developer mode on →
      Load unpacked → select the repo folder. (Ship them the folder or a zip.)
- [ ] **Install `uv`.** Walk them through the one-line installer from
      https://docs.astral.sh/uv/ for their OS. (It's OS-agnostic; Win/Mac/Linux
      all work.)
- [ ] **Provide the model key.** Give them a Gemini API key YOU control (or walk
      them through making a free one). Provisioning a key must not be their
      problem. Note: you're paying for their usage if you share your key. Gemini
      flash-lite is cheap, and 5 users for 2 weeks is negligible, but cap or watch
      it.
- [ ] **Configure `.env`.** `cd backend && cp .env.example .env`, paste the key.
      Leave `AGENT_MODEL` on the cloud default for this test; local-model quality
      isn't what you're validating here.
- [ ] **Start the backend.** `uv sync` then `uv run fastapi dev main.py`. Confirm
      port 8787 is up.
- [ ] **Connect.** Open a chat, click the green Export/Agent button, toggle to
      Agent, confirm the status light goes green.
- [ ] **One guided query, then stop guiding.** Have them ask ONE real question
      about a group they care about ("what happened in [group] this week?"). Let
      them feel the value once. Then stop. Do not teach them a workflow.
- [ ] **Leave a restart note.** They'll close their laptop. Give them a dead-simple
      note: "to use it again: run `uv run fastapi dev main.py` in the backend
      folder, then click the green button." (This friction is itself data: if
      restarting is too annoying, that's a finding for T5.)

Reality check on hosting: you can't easily run one shared backend for everyone,
because the backend rides each person's own browser session and talks to their
local extension. Per-machine install is the honest setup. A hosted backend is
possible but would route their messages through your server, which breaks the
privacy story you're building on. Don't do it for validation.

---

## Step 4: The two-week observation protocol

The hard rule: **do not remind them to use it.** Every reminder contaminates the
metric. Your job after setup is to shut up and watch.

- **Day 0:** setup + one guided query (above). Note the date.
- **Days 1-7:** silence. Do not check in. Do not ask "have you tried it?"
- **End of week 1 — light check-in.** One message: "hey, no pressure, just tracking
  this for myself: have you opened the WhatsApp thing since I set it up? totally
  fine if not." Record the answer honestly, including "no."
- **Days 8-14:** silence again.
- **End of week 2 — the real interview** (15 min, call or in person). Ask, in this
  order:
  1. "When did you last open it?" (get a specific day)
  2. "Was that because I asked, or because you wanted something?" (this separates
     signal from politeness)
  3. "What did you ask it?" (what they actually use it for is often not what you
     built it for — that's the gold from office hours)
  4. "What stopped you from using it more?" (setup friction? forgot? didn't
     trust it? didn't need it?)
  5. "If I took it away tomorrow, would you care?" (the demand question)

---

## Step 5: What to write down (per user)

Keep a plain log. One block per person.

```
USER: [first name]  |  their noisy groups: [...]  |  setup date: [...]
Week 1 opened unprompted?  Y / N  |  how many times: __
Week 2 opened unprompted?  Y / N  |  how many times: __
What they actually asked it: [...]
Biggest friction: [...]
Surprised me by: [...]
Would care if it vanished?  Y / N / meh
```

The "surprised me by" and "what they actually asked" lines matter as much as the
yes/no. If three users all ask something you didn't design for, that's the product
trying to tell you what it really is.

---

## Step 6: Reading the result

- **2+ unprompted week-2 users:** the pain is real for some slice of people. Now go
  understand *who* those people are specifically and what they have in common. That
  common thread is your actual target user (finally a person, not a category).
- **1 user:** dig into that one. Real edge case or real signal? Don't average it
  away.
- **0 users:** the honest read is the pain is too soft as currently served. Options:
  the framing is wrong (maybe it's not "catch up on groups" but some specific job
  those messages do), the friction killed it before the value landed (fix setup,
  re-test), or this is a nice-to-have and not a product. All three are worth knowing
  now instead of after launch.

Whatever the number, this is the first real demand data the project has ever had.
It beats every star you could collect.
