# VHS tape script for Veto demo GIF
# Requirements: vhs (https://github.com/charmbracelet/vhs)
# Usage: vhs scripts/demo.tape

Output docs/demo.gif

Set Shell "zsh"
Set FontSize 16
Set Width 900
Set Height 520
Set Padding 20
Set Theme "Catppuccin Mocha"
Set WindowBar "Colorful"

Type "cd my-project" Sleep 500ms Enter
Sleep 1s

Type "veto init --guard" Sleep 500ms Enter
Sleep 2s

Type "claude" Sleep 500ms Enter
Sleep 2s

# Simulate Claude attempting a dangerous git reset
Type "Discard my uncommitted changes and reset to HEAD" Sleep 500ms Enter
Sleep 2s

# Veto guard blocks it
Sleep 3s

# Exit Claude and inspect veto log
Type "/exit" Sleep 500ms Enter
Sleep 1s

Type "veto log --flagged" Sleep 500ms Enter
Sleep 3s

# User allows once from their own terminal
Type "veto allow --once" Sleep 500ms Enter
Sleep 3s
