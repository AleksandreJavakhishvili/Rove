# vhs tape — bridge startup recording for the README.
#
# Run with:  vhs scripts/demo/bridge.tape
# Output:    scripts/demo/bridge.gif
#
# Design notes:
#   - No custom FontFamily — vhs ships JetBrainsMono Nerd Font bundled; naming
#     a font that isn't installed in the headless chromium falls back to an
#     ugly wide-glyph monospace.
#   - WindowBar gives it a real-terminal look (matters more than you'd think
#     for trust signal on a "one-command setup" demo).
#   - Tighter frame (1100×600), bigger font (16), modest padding — the goal is
#     a hero shot that's legible at 600px wide on the README.

Output scripts/demo/bridge.gif

Set Shell        "zsh"
Set FontSize     16
Set Width        1100
Set Height       600
Set Padding      28
Set Margin       12
Set MarginFill   "#0a7ea4"
Set BorderRadius 10
Set WindowBar    Colorful
Set Theme        "TokyoNight"
Set TypingSpeed  55ms

# Land in the bridge package without that step appearing in the recording.
Hide
Type "cd ~/Desktop/Projects/remoteagent/bridge && clear"
Enter
Sleep 600ms
Show

# The single command — the headline of the README.
Type "pnpm start"
Enter

# With the cert cached locally (which it always is after the first run),
# the bridge prints its QR within ~3s. Keep the wait tight.
Sleep 6s

# Hold the final frame nice and long so a reader has time to read the URL
# and notice the Let's Encrypt / token / deep-link lines.
Sleep 7s
