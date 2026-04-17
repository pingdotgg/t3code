if ($env:T3_SSH_AUTH_SECRET -ne $null) {
  [Console]::Out.WriteLine($env:T3_SSH_AUTH_SECRET)
  exit 0
}
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$prompt = if ($args.Length -gt 0 -and $args[0]) { $args[0] } else { "SSH authentication" }
$form = New-Object System.Windows.Forms.Form
$form.Text = "SSH authentication"
$form.Width = 420
$form.Height = 185
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.Left = 16
$label.Top = 16
$label.Width = 372
$label.Height = 34
$label.Text = $prompt
$textbox = New-Object System.Windows.Forms.TextBox
$textbox.Left = 16
$textbox.Top = 60
$textbox.Width = 372
$textbox.UseSystemPasswordChar = $true
$okButton = New-Object System.Windows.Forms.Button
$okButton.Text = "OK"
$okButton.Left = 232
$okButton.Top = 100
$okButton.Width = 75
$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.Left = 313
$cancelButton.Top = 100
$cancelButton.Width = 75
$okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.AcceptButton = $okButton
$form.CancelButton = $cancelButton
$form.Controls.Add($label)
$form.Controls.Add($textbox)
$form.Controls.Add($okButton)
$form.Controls.Add($cancelButton)
$result = $form.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }
[Console]::Out.WriteLine($textbox.Text)
