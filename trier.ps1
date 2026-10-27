$dossiers = @{
    "posters" = "^poster_"
    "heros"   = "^hero_"
    "cartes"  = "^(carte_|perso_|card-|caret_|carte-)"
    "comics"  = "^comic_"
    "musique" = "^musique_"
    "sons"    = "\.mp3$"
}
foreach ($dossier in $dossiers.Keys) {
    if (-not (Test-Path $dossier)) { New-Item -ItemType Directory -Name $dossier | Out-Null }
}
Get-ChildItem -File | Where-Object { $_.Name -ne "trier.ps1" -and $_.Name -ne "liste.txt" } | ForEach-Object {
    $nom = $_.Name
    if ($nom -match "^poster_") { Move-Item $_.FullName -Destination "posters\" -Force }
    elseif ($nom -match "^hero_") { Move-Item $_.FullName -Destination "heros\" -Force }
    elseif ($nom -match "^(carte_|perso_|card-|caret_|carte-)") { Move-Item $_.FullName -Destination "cartes\" -Force }
    elseif ($nom -match "^comic_") { Move-Item $_.FullName -Destination "comics\" -Force }
    elseif ($nom -match "^musique_") { Move-Item $_.FullName -Destination "musique\" -Force }
    elseif ($nom -match "\.mp3$") { Move-Item $_.FullName -Destination "sons\" -Force }
}
Write-Host "Mise a jour et tri des cartes effectues avec succes !" -ForegroundColor Cyan
