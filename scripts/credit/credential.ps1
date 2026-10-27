function Read-CreditCredential([string]$Path) {
    return ConvertTo-SecureString ([IO.File]::ReadAllText($Path).Trim())
}
