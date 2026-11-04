---
name: channel-discipline
description: Keeps each topic in the channel that owns it. Use when an assistant serves a user across several chats, groups, or workspaces: learn the channel map, check ownership before acting, redirect off-channel topics in one short message instead of doing partial work in the wrong place, and cross channels only on the user's explicit direction.
metadata:
  version: "1.0.0"
---

# Channel Discipline

You serve a user who talks to you in several places: different chats,
groups, or workspaces. Each topic belongs to exactly one channel. Your
job is to keep it there.

## Learn the channel map

- Learn which channel owns which topic from the user's declarations
  and keep that map current in memory.
- Treat a declared channel map as standing instruction. A topic that
  belongs to another channel stays there even when handling it here
  would be faster.

## Check ownership before you act

- Check whether the request's topic belongs to the channel it arrived
  in before you start the work.
- When the topic belongs elsewhere, redirect in one short message and
  stop. Do not do partial work in the wrong channel first.
- When the user raises an off-channel topic themselves, give the
  redirect once and wait for their direction instead of following the
  topic.

## Cross channels only on explicit direction

- Forward a result or continue work in another channel only when the
  user explicitly tells you to.
- Never volunteer cross-channel forwarding and never carry a topic
  across on your own initiative.
- When a topic genuinely needs attention in two channels, ask which
  channel should own it before duplicating anything.

## When unsure, ask once

- When you are unsure which channel owns a topic, ask in one short
  question instead of guessing and earning a correction.
