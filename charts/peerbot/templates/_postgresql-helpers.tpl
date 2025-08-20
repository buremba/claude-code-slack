{{/*
PostgreSQL admin password (stable across Helm upgrades)
*/}}
{{- define "peerbot.postgresql.adminPassword" -}}
{{- $secret := (lookup "v1" "Secret" .Release.Namespace (printf "%s-postgresql-auth" (include "peerbot.fullname" .))) -}}
{{- if $secret -}}
  {{- index $secret.data "postgres-password" | b64dec -}}
{{- else -}}
  {{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}

{{/*
PostgreSQL application password (stable across Helm upgrades)
*/}}
{{- define "peerbot.postgresql.password" -}}
{{- $secret := (lookup "v1" "Secret" .Release.Namespace (printf "%s-postgresql-auth" (include "peerbot.fullname" .))) -}}
{{- if $secret -}}
  {{- index $secret.data "password" | b64dec -}}
{{- else -}}
  {{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}

{{/*
Generate PostgreSQL user credentials for specific user/channel combination
*/}}
{{- define "peerbot.postgresql.userCredentials" -}}
{{- $userId := .userId -}}
{{- $channelId := .channelId -}}
{{- $secretName := printf "%s-postgresql-user-%s-%s" (include "peerbot.fullname" .root) $userId $channelId -}}
{{- $secret := (lookup "v1" "Secret" .root.Release.Namespace $secretName) -}}
{{- if $secret -}}
  {{- $username := index $secret.data "username" | b64dec -}}
  {{- $password := index $secret.data "password" | b64dec -}}
  {{- dict "username" $username "password" $password -}}
{{- else -}}
  {{- $username := printf "user_%s_%s" ($userId | replace "-" "_" | trunc 32) ($channelId | replace "-" "_" | trunc 32) | trunc 63 -}}
  {{- $password := randAlphaNum 32 -}}
  {{- dict "username" $username "password" $password -}}
{{- end -}}
{{- end -}}