param(
  [string]$Url = "http://localhost:5000/api/employee/tasks/6953e6c4213814b090f638cb/messages"
)

try {
  $r = Invoke-WebRequest -Uri $Url -Method Post -Body '{"text":"ping"}' -ContentType 'application/json' -Headers @{ Authorization = 'Bearer invalid' } -UseBasicParsing
  Write-Host "STATUS" $r.StatusCode
  Write-Host $r.Content
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    Write-Host "STATUS" $resp.StatusCode.value__
    try {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $body = $sr.ReadToEnd()
      if ($body) { Write-Host $body }
    } catch {}
  } else {
    Write-Host "NO RESPONSE" $_.Exception.Message
  }
}
