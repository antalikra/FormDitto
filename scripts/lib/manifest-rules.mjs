// Release rules for manifest.json. Used by the build (refuses to package a manifest that breaks
// them) and by test/unit/manifest.test.js.

export const REQUIRED_PERMISSIONS = ['activeTab', 'scripting', 'sidePanel', 'storage'];
export const OPTIONAL_HOSTS = ['https://*/*', 'http://*/*'];
export const FORBIDDEN_KEYS = ['host_permissions', 'content_scripts', 'externally_connectable', 'web_accessible_resources', 'sandbox', 'optional_permissions', 'update_url', 'key', 'oauth2', 'chrome_url_overrides', 'devtools_page'];
export const CSP_DIRECTIVES = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"];

/** Returns a list of problems (empty when the manifest is fine for release). */
export function checkManifest(m) {
  const problems = [];
  if (m.manifest_version !== 3) problems.push('manifest_version must be 3');
  const perms = [...(m.permissions || [])].sort();
  if (JSON.stringify(perms) !== JSON.stringify(REQUIRED_PERMISSIONS)) problems.push(`permissions must be exactly ${REQUIRED_PERMISSIONS.join(', ')}`);
  if (JSON.stringify(m.optional_host_permissions) !== JSON.stringify(OPTIONAL_HOSTS)) problems.push('optional_host_permissions must be the http(s) wildcards (requested per site at runtime)');
  for (const k of FORBIDDEN_KEYS) if (k in m) problems.push(`"${k}" must not be declared`);
  const csp = (m.content_security_policy && m.content_security_policy.extension_pages) || '';
  for (const d of CSP_DIRECTIVES) if (!csp.includes(d)) problems.push(`CSP is missing "${d}"`);
  if (/unsafe-eval|unsafe-inline|wasm-unsafe-eval|https?:/.test(csp)) problems.push('CSP must not allow eval, inline code or remote sources');
  const text = JSON.stringify(m);
  if (text.includes('<all_urls>')) problems.push('<all_urls> is not allowed');
  if (!m.background || m.background.service_worker !== 'background.js') problems.push('background service worker must be background.js');
  return problems;
}
