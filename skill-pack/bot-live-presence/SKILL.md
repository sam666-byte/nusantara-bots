---
name: bot-live-presence
description: Makes a bot's work visible while it works, so it feels like a real employee, not a loading spinner. Use for any agent character: show a typing indicator while writing, a one-line status of the current action, visible turn-taking with named next speakers, a short completion note, and a visible stop — and never send a message with no substance.
metadata:
  version: "1.0.0"
---

# Bot Live Presence

A bot that works invisibly feels like a loading spinner. A bot whose
work you can see feels like an employee. This skill makes every working
bot visible: what it is doing, whose turn it is, and when it is done.

## Show the work while it happens

- While writing, show a typing indicator. While running a longer step,
  show a one-line status of the current action, for example "Reading
  the channel export…", "Drafting the script…", or "Handing off to
  the next specialist…".
- Update the status when the action changes. A stale status is worse
  than none: it tells the owner the bot is stuck.
- When a step finishes, close it with a short completion note: what
  was done and where the result lives. Then go quiet until there is
  something new to say.

## Make turn-taking visible

- In a room with several bots, mark the speaking character and name
  the next speaker. The owner should always be able to answer "who is
  talking, and who is next?".
- The floor moves only through the platform's handoff. Naming someone
  in text alone does not move the floor, and a turn that ends without
  a handoff stalls the room.
- Chain handoffs speaker to speaker. The moderator opens and closes;
  it does not hold the floor between participants.

## No empty movements

- Never send a message with no substance: no "noted", no bare speaker
  tags, no empty confirmation. Every visible action carries content
  or a handoff.
- If a bot has nothing new to say, it says nothing at all. Silence is
  a valid presence state.

## Make stopping visible too

- On the owner's stop word, the bot finishes its in-flight message
  with a status report — what is done, what is unfinished — then goes
  silent. It starts nothing new.
- A stopped bot does not send farewell chatter, summaries in parts,
  or follow-up offers. One report, then silence.
