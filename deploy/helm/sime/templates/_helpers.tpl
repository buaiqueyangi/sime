{{/* SIME Helm helpers */}}
{{- define "sime.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "sime.labels" -}}
app.kubernetes.io/name: sime
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "sime.selectorLabels" -}}
app.kubernetes.io/name: sime
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
