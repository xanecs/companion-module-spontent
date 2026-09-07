# Spontent GFX (NodeCG volleyball graphics)

Controls the Spontent NodeCG graphics used on the dashboard **Stream** tab:
toggle the full-screen and overlay graphics, fire player lower-thirds by shirt
number, and expose the team rosters and names as variables so you can build a
roster-selection surface in Companion.

## Configuration

| Field                   | Notes                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Base URL**            | Your NodeCG instance, e.g. `https://93.d.vbl.spontent-gfx.de`                                                                                                                                                       |
| **Socket Token**        | _Recommended._ The value of the `socketToken` cookie from a logged-in dashboard session. In the browser: open the dashboard, DevTools → Application → Cookies → copy `socketToken`. It is stable for your instance. |
| **Username / Password** | Optional. If no token is set the module attempts to log in and fetch a token. Depending on the server this may only work from a real browser — if login fails, set the Socket Token manually.                       |

## Actions

- **Graphic: Show / Hide / Toggle** — pick a graphic (Pre Game, Tabelle,
  Kaderliste Home/Away, Starting Six Home/Away, Score Bug, Score Lowerthird,
  Referees) and an action. Full-screen graphics are mutually exclusive; showing
  one replaces whatever full-screen graphic is live.
- **Player Lowerthird: Fire by shirt number** — choose team (Home/Away) and a
  shirt number (supports variables), then Show / Hide / Toggle.
- **Hide graphic slot** — clear the full-screen, score-bug, lowerthird slot, or
  all of them.

## Feedbacks

- **Graphic is live** — true while the selected graphic is on air. Use it to
  colour the button that toggles it.
- **Player Lowerthird is live** — true while a player lower-third is on air for
  the selected team (and shirt number, if given; leave empty to match any).

## Variables

- `home_name`, `away_name`, `home_shortname`, `away_shortname` — team names.
- `home_count`, `away_count` — roster sizes.
- `home_<i>_number`, `home_<i>_name`, `home_<i>_firstname`, `home_<i>_lastname`
  and the `away_<i>_…` equivalents — one entry per squad player, indexed from 0
  and ordered by jersey number (matching the dashboard's list). Home is Team 1,
  Away is Team 2.

Example: a button whose text is `$(spontent-graphics:home_0_number) $(spontent-graphics:home_0_name)`
with a _Player Lowerthird: Fire by shirt number_ action using number
`$(spontent-graphics:home_0_number)`.
