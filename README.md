# Bracketeer — offline tournament tracker

A single-page website for running a one-off local tournament: enter the teams, pick a
format, generate the pairings, then type the scores in as they happen. Winners drop into
the next pairing automatically.

Everything runs in the browser. No server, no database, no accounts, no internet — open
`index.html` and it works, including from a USB stick or a downloaded folder.

## Using it

1. Open `index.html` in any modern browser.
2. In the top section give the tournament a name, choose the number of teams (2–64) and
   type the team names — or hit **Paste a list** and drop in one name per line.
3. Choose a format and any options, then press **Generate tournament**.
4. Type scores straight into the boxes on each match card. The winner is highlighted and
   appears in the following round immediately.

### Formats

| Format | What it does |
| --- | --- |
| Single elimination | Straight knockout. Non-power-of-two fields get byes, spread across the bracket by seed. Optional third-place match. |

| Double elimination | Upper and lower brackets — two losses to go out. Optional bracket reset in the grand final (game two is only playable when the lower-bracket team wins game one). |
| Round robin | Everyone plays everyone, with a live table. Optional home-and-away second leg, optional draws. |

The order teams are typed in is the seeding: seed 1 plays the lowest seed, and byes go to
the top seeds. **Shuffle seeding** randomises it for you.

Byes are never shown as fixtures — a team with no opponent is listed under its round as
going straight through, and simply appears in the next round. The setup panel tells you
how many byes a team count implies before you generate anything, so five teams reads as
"8-team bracket · 3 byes in round one" rather than springing three walkovers on you.

### Scores and results

- Scores are plain numbers — goals, points, legs, frames, whatever the sport uses.
- Knockout matches need a winner; a tie is flagged on the card until it is broken.
- Round robin uses 3 points for a win and 1 for a draw, ranked on points, then goal
  difference, then goals scored.
- **Clear** on a match card wipes that result; everything downstream reverts to "to be
  decided".
- Renaming teams after the draw: edit the names in the setup panel and press
  **Apply team names** — the bracket is left untouched.

### Saving and sharing

The tournament is written to the browser's local storage after every keystroke, so a
reload or a closed laptop lid loses nothing. It lives in that one browser on that one
device: use **Export** for a JSON backup, **Import** to restore it (or move it to another
machine), and **Print** for a paper copy of the bracket.

## Files

```
index.html      markup
css/styles.css  styling, light and dark themes, responsive layout
js/app.js       bracket generation, result propagation, storage
```

No build step and no dependencies — edit the files and refresh.
