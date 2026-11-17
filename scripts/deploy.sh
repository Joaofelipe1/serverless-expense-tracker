#!/usr/bin/env bash
# Faz o deploy completo: backend (SAM) + frontend (S3/CloudFront).
# Uso: ./scripts/deploy.sh [nome-da-stack] [regiao]
# Sem regiao, usa AWS_REGION ou a regiao padrao do seu perfil do AWS CLI.
set -euo pipefail

STACK="${1:-expense-tracker}"
REGION="${2:-${AWS_REGION:-$(aws configure get region 2>/dev/null || echo sa-east-1)}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

deploy_backend() {
  sam deploy --stack-name "$STACK" --region "$REGION" \
    --resolve-s3 --capabilities CAPABILITY_IAM \
    --no-confirm-changeset --no-fail-on-empty-changeset \
    --parameter-overrides "AllowedOrigin=$1"
}

echo "==> Build do backend"
sam build

# Primeiro deploy usa "*" no CORS; depois restringimos ao dominio do CloudFront.
CURRENT_ORIGIN="*"
if aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
  CURRENT_ORIGIN="$(output WebsiteUrl)"
fi

echo "==> Deploy da infraestrutura (CORS: $CURRENT_ORIGIN)"
deploy_backend "$CURRENT_ORIGIN"

SITE_URL="$(output WebsiteUrl)"
if [[ "$CURRENT_ORIGIN" != "$SITE_URL" ]]; then
  echo "==> Restringindo CORS para $SITE_URL"
  deploy_backend "$SITE_URL"
fi

echo "==> Gerando frontend/config.js"
cat > frontend/config.js <<EOF
window.APP_CONFIG = {
  region: "$REGION",
  apiUrl: "$(output ApiUrl)",
  userPoolId: "$(output UserPoolId)",
  userPoolClientId: "$(output UserPoolClientId)",
};
EOF

echo "==> Enviando frontend para o S3"
aws s3 sync frontend/ "s3://$(output FrontendBucketName)/" \
  --region "$REGION" --delete --exclude "config.example.js"

echo "==> Invalidando cache do CloudFront"
aws cloudfront create-invalidation --distribution-id "$(output DistributionId)" \
  --paths "/*" --query "Invalidation.Id" --output text

echo
echo "Pronto! Acesse: $SITE_URL"
