# ================================
# CONFIG – EDIT ONLY THESE VALUES
# ================================
$PROJECT_ID = "appealpack-uk-prod-101"
$PROJECT_NAME = "Parking Appeal Pack Prod"
$REGION = "europe-west2"
# ================================

Write-Host "Creating GCP project $PROJECT_ID..."

gcloud projects create $PROJECT_ID --name="$PROJECT_NAME"

if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create project. It may already exist or you lack permissions."
  exit 1
}

Write-Host "Setting active gcloud project..."
gcloud config set project $PROJECT_ID

Write-Host "Verifying project..."
gcloud projects describe $PROJECT_ID

Write-Host "Done."
