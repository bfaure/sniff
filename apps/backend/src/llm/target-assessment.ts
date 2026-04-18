import { db } from '../db.js';
import { llmInvoke } from './client.js';
import { wsHub } from '../ws/hub.js';
import { recordFinding } from './findings.js';
import type { LLMMessage } from '@sniff/shared';

const SYSTEM_BASE = `You are an expert penetration tester performing a targeted vulnerability assessment. You are analyzing HTTP traffic captured through an interception proxy. Be thorough, precise, and evidence-based. Only report findings you have evidence for in the provided traffic. For each finding, include the specific request/response data that supports it.`;

export interface VulnCategory {
  id: string;
  name: string;
  owaspId?: string;
  description: string;
  systemPrompt: string;
}

export const VULN_CATEGORIES: VulnCategory[] = [
  // OWASP Top 10 (2021)
  {
    id: 'broken-access-control',
    name: 'Broken Access Control',
    owaspId: 'A01:2021',
    description: 'IDOR, privilege escalation, forced browsing, CORS misconfiguration',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Broken Access Control vulnerabilities (OWASP A01:2021):
- Insecure Direct Object References (IDOR): sequential/guessable IDs in URLs or parameters that could reference other users' resources
- Horizontal privilege escalation: same role accessing other users' data
- Vertical privilege escalation: lower role accessing admin endpoints
- Missing function-level access control: admin/internal endpoints accessible without proper authorization
- CORS misconfiguration: overly permissive Access-Control-Allow-Origin, credentials allowed with wildcard
- Forced browsing: access to unlinked pages or directories (backup files, admin panels)
- JWT/token manipulation: weak tokens, missing signature validation indicators
- Parameter tampering: role/permission fields in request bodies

For each finding, cite the exact request URL, parameter, or header that demonstrates the issue.`,
  },
  {
    id: 'cryptographic-failures',
    name: 'Cryptographic Failures',
    owaspId: 'A02:2021',
    description: 'Sensitive data exposure, weak TLS, cleartext transmission',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Cryptographic Failures (OWASP A02:2021):
- Sensitive data in cleartext: passwords, tokens, SSNs, credit cards in request/response bodies
- Sensitive data in URLs: tokens, credentials, PII in query parameters (logged in server logs, browser history)
- Weak or missing encryption indicators: HTTP links in responses, mixed content
- Sensitive data in cookies without Secure flag
- Weak hashing indicators: MD5/SHA1 hashes visible in responses
- Excessive data exposure: API responses returning more fields than needed (full user objects with password hashes, internal IDs)
- Hardcoded secrets: API keys, credentials in headers or bodies that appear to be hardcoded
- Missing data classification: sensitive data returned without appropriate caching headers (Cache-Control, Pragma)

For each finding, cite the exact field, header, or parameter containing the sensitive data.`,
  },
  {
    id: 'injection',
    name: 'Injection',
    owaspId: 'A03:2021',
    description: 'SQL injection, XSS, command injection, LDAP injection, template injection',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Injection vulnerabilities (OWASP A03:2021):
- SQL injection indicators: error messages revealing SQL syntax, unparameterized queries visible in responses, numeric IDs without validation
- Cross-site scripting (XSS): user input reflected in responses without encoding, missing Content-Type headers, missing X-XSS-Protection
- Command injection: parameters that could be passed to OS commands (filenames, paths, hostnames)
- LDAP injection: search/filter parameters that interact with directory services
- Server-Side Template Injection (SSTI): template syntax in parameters, template engine error messages
- NoSQL injection: JSON/BSON query operators in parameters
- Header injection: CRLF in header values, host header manipulation
- Expression Language injection: EL/OGNL/SpEL expressions in parameters

Analyze request parameters, headers, and body fields for injection surfaces. Check responses for error messages that reveal backend technology.`,
  },
  {
    id: 'insecure-design',
    name: 'Insecure Design',
    owaspId: 'A04:2021',
    description: 'Business logic flaws, missing rate limiting, insufficient anti-automation',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Insecure Design (OWASP A04:2021):
- Business logic flaws: price manipulation, quantity tampering, step-skipping in multi-step workflows
- Missing rate limiting: no evidence of rate limiting on sensitive endpoints (login, password reset, OTP verification)
- Race conditions: endpoints that modify state without apparent locking (account balance, inventory)
- Missing anti-automation: no CAPTCHA on public forms, no proof-of-work on expensive operations
- Insufficient input validation at the business level: negative quantities, zero-cost items, dates in the past
- Missing referrer/origin validation on state-changing requests
- Predictable resource creation: sequential IDs, predictable URLs for new resources
- Missing account lockout: login endpoints without lockout indicators

Look at the business logic implied by the API structure and parameters, not just technical vulnerabilities.`,
  },
  {
    id: 'security-misconfiguration',
    name: 'Security Misconfiguration',
    owaspId: 'A05:2021',
    description: 'Default configs, verbose errors, unnecessary features, missing hardening',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Security Misconfiguration (OWASP A05:2021):
- Missing security headers: Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security, Permissions-Policy, Referrer-Policy
- Verbose error messages: stack traces, SQL errors, framework debug output, internal paths
- Server information disclosure: Server header, X-Powered-By, technology-specific headers
- Default credentials/endpoints: common admin paths, default API documentation endpoints (/swagger, /graphql, /api-docs)
- Directory listing enabled: responses that look like directory indexes
- Unnecessary HTTP methods: OPTIONS responses showing PUT/DELETE/TRACE when not needed
- CORS misconfiguration: wildcard origins, credentials with wildcard
- Cookie misconfiguration: missing HttpOnly, Secure, SameSite attributes
- Debug mode indicators: debug parameters accepted, verbose logging in responses

Check every response header and error response for configuration weaknesses.`,
  },
  {
    id: 'vulnerable-components',
    name: 'Vulnerable & Outdated Components',
    owaspId: 'A06:2021',
    description: 'Known vulnerable libraries, outdated server software, unpatched frameworks',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Vulnerable and Outdated Components (OWASP A06:2021):
- Server software versions: version numbers in Server header, X-Powered-By, or error pages
- Framework versions: technology-specific headers or response patterns revealing version (e.g., Rails, Django, Express, Spring)
- JavaScript library versions: references to known vulnerable JS library versions in responses
- API version indicators: deprecated API versions still in use
- Known CVE indicators: server/framework versions with known public CVEs
- Outdated TLS/protocol indicators: older cipher suites, protocol version headers
- Dependency information disclosure: package.json, requirements.txt, Gemfile exposed

Identify any version information and note if the version has known vulnerabilities.`,
  },
  {
    id: 'auth-failures',
    name: 'Identification & Authentication Failures',
    owaspId: 'A07:2021',
    description: 'Weak authentication, session management flaws, credential stuffing vectors',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Identification and Authentication Failures (OWASP A07:2021):
- Weak session management: predictable session tokens, tokens in URLs, missing session expiration
- Missing multi-factor authentication indicators on sensitive operations
- Weak password policy: no complexity requirements visible in error messages or API contracts
- Session fixation: session tokens not rotated after authentication
- Credential exposure: plaintext credentials in requests, basic auth without TLS
- JWT weaknesses: missing expiration, weak algorithm (none, HS256 with weak key), sensitive data in payload
- Cookie-based session issues: missing HttpOnly/Secure flags on session cookies, overly long expiration
- Account enumeration: different responses for valid vs invalid usernames
- Password reset weaknesses: predictable tokens, no rate limiting, token reuse

Analyze authentication flows, session tokens, and credential handling patterns.`,
  },
  {
    id: 'data-integrity',
    name: 'Software & Data Integrity Failures',
    owaspId: 'A08:2021',
    description: 'Insecure deserialization, CI/CD vulnerabilities, unsigned updates',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Software and Data Integrity Failures (OWASP A08:2021):
- Insecure deserialization: serialized object formats in requests (Java serialized objects, PHP serialize, pickle)
- Missing integrity verification: resources loaded without SRI (Subresource Integrity) hashes
- Mass assignment: request bodies with extra fields that could set admin/role/internal properties
- Unsafe object binding: framework-specific mass assignment patterns (Rails strong params bypass, Spring model binding)
- Missing CSRF protection: state-changing requests without CSRF tokens or SameSite cookies
- Auto-binding vulnerabilities: JSON/form payloads with unexpected fields accepted by the server

Look for deserialization indicators and data binding patterns in request/response pairs.`,
  },
  {
    id: 'logging-monitoring',
    name: 'Security Logging & Monitoring Failures',
    owaspId: 'A09:2021',
    description: 'Missing audit trails, insufficient logging, no monitoring indicators',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Security Logging and Monitoring Failures (OWASP A09:2021):
- Missing audit trail indicators: no request IDs or correlation headers in responses
- Error handling without logging indicators: generic error pages that may not be logged
- Authentication events without monitoring: login failures returning generic 401 without rate limiting or lockout
- Missing security event headers: no indication of request tracing (X-Request-Id, X-Correlation-Id)
- Sensitive operations without audit: DELETE/PUT operations on critical resources without confirmation
- Missing breach detection indicators: no anomaly detection headers or rate limiting evidence

Note: This category can only be partially assessed from traffic analysis. Flag indicators that suggest insufficient monitoring.`,
  },
  {
    id: 'ssrf',
    name: 'Server-Side Request Forgery (SSRF)',
    owaspId: 'A10:2021',
    description: 'URL parameters, webhook configs, file imports from URLs',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Server-Side Request Forgery (OWASP A10:2021):
- URL parameters: any parameter that accepts a URL, hostname, or IP address that the server may fetch
- Webhook/callback URLs: endpoints accepting callback or notification URLs
- File import from URL: parameters for importing files, images, or data from external URLs
- PDF/document generation: services that render URLs into documents
- Internal service indicators: responses revealing internal hostnames, IPs (10.x, 172.16-31.x, 192.168.x), or port numbers
- Cloud metadata indicators: any reference to 169.254.169.254 or cloud-specific metadata endpoints
- DNS rebinding vectors: hostname parameters without apparent validation

Identify any parameter or endpoint where the server might make requests to user-controlled URLs.`,
  },

  // Additional important vulns beyond OWASP Top 10
  {
    id: 'api-security',
    name: 'API Security Issues',
    description: 'REST/GraphQL-specific vulns, excessive data exposure, lack of resource/rate limiting',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on API-specific security issues:
- Excessive data exposure: API responses returning more data than the client needs
- Lack of resource limiting: no pagination limits, unbounded query results
- Broken object-level authorization: accessing resources by ID without ownership verification
- Broken function-level authorization: accessing admin API endpoints as regular user
- Mass assignment via API: extra fields in POST/PUT accepted without filtering
- GraphQL-specific: introspection enabled, deeply nested queries (DoS), batch query attacks
- Missing request validation: no schema validation, type coercion issues
- Inconsistent error handling: different error formats revealing implementation details
- Version mismatch: deprecated API versions with known issues still accessible
- Missing Content-Type validation: accepting unexpected content types

Analyze the API design patterns, response shapes, and endpoint structure.`,
  },
  {
    id: 'information-disclosure',
    name: 'Information Disclosure',
    description: 'Internal IPs, stack traces, debug info, technology fingerprinting',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Information Disclosure vulnerabilities:
- Internal IP addresses: 10.x, 172.16-31.x, 192.168.x in responses or headers
- Stack traces and debug output: detailed error messages revealing code structure
- Technology fingerprinting: exact versions of servers, frameworks, libraries
- Source code disclosure: code snippets in error messages or responses
- Database information: table names, column names, query structures in errors
- File paths: absolute server-side file paths in errors or responses
- Environment variables: env var names or values leaked in responses
- Third-party service details: API keys, endpoints, or configuration for external services
- Email addresses, usernames, or internal user information
- Backup/configuration files: .bak, .env, .git, .svn references

Examine every header, error response, and response body for unintended information leakage.`,
  },
  {
    id: 'open-redirect',
    name: 'Open Redirect & URL Manipulation',
    description: 'Unvalidated redirects, URL parameter manipulation, path traversal',
    systemPrompt: `${SYSTEM_BASE}

Focus EXCLUSIVELY on Open Redirect and URL manipulation:
- Open redirects: parameters like redirect_url, return_to, next, callback, goto that control navigation
- 3xx responses with user-controllable Location headers
- JavaScript-based redirects using user-controlled parameters
- Path traversal: parameters containing file paths, ../ sequences, or path components
- URL manipulation: parameters that construct URLs server-side
- Host header attacks: applications using Host header to generate URLs in responses

Identify any parameter or header that influences URL generation or redirection behavior.`,
  },
];

interface AssessmentFinding {
  categoryId: string;
  categoryName: string;
  owaspId?: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  evidence: string;
  explanation: string;
  suggestedTest: string | null;
}

interface AssessmentProgress {
  assessmentId: string;
  host: string;
  pathPrefix: string | null;
  currentCategory: string;
  currentCategoryIndex: number;
  totalCategories: number;
  findings: AssessmentFinding[];
  status: 'running' | 'done' | 'error';
  totalCost: number;
  error?: string;
}

// Active assessments tracking
const activeAssessments = new Map<string, { cancelled: boolean }>();

function formatExchangesSummary(exchanges: Array<{
  method: string;
  url: string;
  requestHeaders: string;
  requestBody: Uint8Array | null;
  statusCode: number | null;
  responseHeaders: string | null;
  responseBody: Uint8Array | null;
}>): string {
  const parts: string[] = [];
  const MAX_EXCHANGES = 50; // limit to prevent token overflow
  const MAX_BODY = 2048; // 2KB per body

  const subset = exchanges.slice(0, MAX_EXCHANGES);

  for (let i = 0; i < subset.length; i++) {
    const ex = subset[i];
    parts.push(`--- Exchange ${i + 1} ---`);
    parts.push(`${ex.method} ${ex.url}`);

    try {
      const reqHeaders = JSON.parse(ex.requestHeaders);
      for (const [k, v] of Object.entries(reqHeaders)) {
        parts.push(`${k}: ${v}`);
      }
    } catch { /* skip */ }

    if (ex.requestBody) {
      const body = Buffer.from(ex.requestBody).toString('utf-8');
      parts.push('');
      parts.push(body.length > MAX_BODY ? body.slice(0, MAX_BODY) + '\n... [truncated]' : body);
    }

    if (ex.statusCode != null) {
      parts.push(`\nResponse: ${ex.statusCode}`);
      if (ex.responseHeaders) {
        try {
          const resHeaders = JSON.parse(ex.responseHeaders);
          for (const [k, v] of Object.entries(resHeaders)) {
            parts.push(`${k}: ${v}`);
          }
        } catch { /* skip */ }
      }
      if (ex.responseBody) {
        const body = Buffer.from(ex.responseBody).toString('utf-8');
        parts.push('');
        parts.push(body.length > MAX_BODY ? body.slice(0, MAX_BODY) + '\n... [truncated]' : body);
      }
    }
    parts.push('');
  }

  if (exchanges.length > MAX_EXCHANGES) {
    parts.push(`\n[${exchanges.length - MAX_EXCHANGES} additional exchanges omitted for brevity]`);
  }

  return parts.join('\n');
}

export async function runTargetAssessment(host: string, assessmentId: string, pathPrefix?: string): Promise<void> {
  const control = { cancelled: false };
  activeAssessments.set(assessmentId, control);

  const allFindings: AssessmentFinding[] = [];
  let totalCost = 0;
  const label = pathPrefix ? `${host}${pathPrefix}` : host;

  try {
    // Load all exchanges for this host (and optional path prefix)
    const exchanges = await db.exchange.findMany({
      where: {
        host,
        ...(pathPrefix ? { path: { startsWith: pathPrefix } } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: 200, // reasonable limit
    });

    if (exchanges.length === 0) {
      wsHub.broadcast({
        type: 'assessment:progress',
        data: {
          assessmentId,
          host,
          pathPrefix: pathPrefix || null,
          currentCategory: '',
          currentCategoryIndex: 0,
          totalCategories: VULN_CATEGORIES.length,
          findings: [],
          status: 'error',
          totalCost: 0,
          error: `No exchanges found for ${label}`,
        } as AssessmentProgress,
      });
      return;
    }

    const exchangeText = formatExchangesSummary(exchanges);

    // Iterate through each vuln category
    for (let i = 0; i < VULN_CATEGORIES.length; i++) {
      if (control.cancelled) break;

      const category = VULN_CATEGORIES[i];

      // Broadcast progress
      wsHub.broadcast({
        type: 'assessment:progress',
        data: {
          assessmentId,
          host,
          pathPrefix: pathPrefix || null,
          currentCategory: category.name,
          currentCategoryIndex: i,
          totalCategories: VULN_CATEGORIES.length,
          findings: allFindings,
          status: 'running',
          totalCost,
        } as AssessmentProgress,
      });

      const messages: LLMMessage[] = [
        { role: 'system', content: category.systemPrompt },
        {
          role: 'user',
          content: `Analyze the following ${exchanges.length} HTTP exchanges captured from the target "${label}"${pathPrefix ? ` (filtered to path prefix: ${pathPrefix})` : ''} for ${category.name} vulnerabilities${category.owaspId ? ` (${category.owaspId})` : ''}.

Severity calibration — be precise, do not over-rate:
- critical: Directly exploitable, no user interaction, full compromise (RCE, auth bypass, pre-auth SQLi)
- high: Directly exploitable with significant impact (stored XSS, IDOR, SSRF to internal)
- medium: Exploitable but requires conditions or chaining (reflected XSS, CSRF)
- low: Minor issues with limited impact (verbose errors, insecure cookie flags on non-session cookies)
- info: Defense-in-depth, best practices, hardening (missing headers like CSP/HSTS/X-Frame-Options, server version disclosure)

Missing security headers are ALWAYS "info" severity — they are hardening measures, not directly exploitable.

Respond with a JSON object (no markdown fences) in this exact format:
{
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "cvss": 7.5,
      "cvssVector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
      "title": "short title of the finding",
      "evidence": "the specific request/response data that shows this issue",
      "explanation": "why this is a vulnerability and its impact",
      "suggestedTest": "a concrete curl command or payload to confirm/exploit this, or null"
    }
  ],
  "summary": "brief assessment of this category for this target"
}

If no vulnerabilities are found in this category, return {"findings": [], "summary": "..."}

HTTP Traffic:
${exchangeText}`,
        },
      ];

      try {
        const result = await llmInvoke(messages, 'reasoning', undefined, 'assessment');
        totalCost += result.costUsd;

        // Parse findings
        let parsed: { findings: Array<{ severity: string; title: string; evidence: string; explanation: string; suggestedTest: string | null; cvss?: number; cvssVector?: string }>; summary: string };
        try {
          const cleaned = result.text.replace(/```(?:json)?\s*\n?/g, '').replace(/```\s*$/g, '').trim();
          parsed = JSON.parse(cleaned);
        } catch {
          // If parsing fails, treat the whole response as a single info finding
          parsed = {
            findings: [{
              severity: 'info',
              title: `${category.name} Analysis`,
              evidence: 'See raw response',
              explanation: result.text,
              suggestedTest: null,
            }],
            summary: result.text.slice(0, 200),
          };
        }

        for (const f of parsed.findings) {
          allFindings.push({
            categoryId: category.id,
            categoryName: category.name,
            owaspId: category.owaspId,
            severity: f.severity as AssessmentFinding['severity'],
            title: f.title,
            evidence: f.evidence,
            explanation: f.explanation,
            suggestedTest: f.suggestedTest,
          });

          // Persist to first-class Finding table (with dedupe)
          recordFinding({
            host,
            source: 'assessment',
            severity: (f.severity || 'info') as any,
            type: category.id,
            title: f.title,
            detail: f.explanation || '',
            evidence: f.evidence || null,
            suggestedTest: f.suggestedTest || null,
            categoryName: category.name,
            owaspId: category.owaspId || null,
            cvss: f.cvss ?? null,
            cvssVector: f.cvssVector || null,
          }).catch((err) => console.error('[assessment] recordFinding error:', err));
        }
      } catch (err) {
        console.error(`[assessment] Error analyzing ${category.name}:`, err);
        allFindings.push({
          categoryId: category.id,
          categoryName: category.name,
          owaspId: category.owaspId,
          severity: 'info',
          title: `Error analyzing ${category.name}`,
          evidence: '',
          explanation: (err as Error).message,
          suggestedTest: null,
        });
      }
    }

    // Final broadcast
    wsHub.broadcast({
      type: 'assessment:progress',
      data: {
        assessmentId,
        host,
        pathPrefix: pathPrefix || null,
        currentCategory: '',
        currentCategoryIndex: VULN_CATEGORIES.length,
        totalCategories: VULN_CATEGORIES.length,
        findings: allFindings,
        status: control.cancelled ? 'done' : 'done',
        totalCost,
      } as AssessmentProgress,
    });
  } catch (err) {
    wsHub.broadcast({
      type: 'assessment:progress',
      data: {
        assessmentId,
        host,
        pathPrefix: pathPrefix || null,
        currentCategory: '',
        currentCategoryIndex: 0,
        totalCategories: VULN_CATEGORIES.length,
        findings: allFindings,
        status: 'error',
        totalCost,
        error: (err as Error).message,
      } as AssessmentProgress,
    });
  } finally {
    activeAssessments.delete(assessmentId);
  }
}

export function cancelAssessment(assessmentId: string): boolean {
  const control = activeAssessments.get(assessmentId);
  if (control) {
    control.cancelled = true;
    return true;
  }
  return false;
}

export function getCategories(): VulnCategory[] {
  return VULN_CATEGORIES.map(({ id, name, owaspId, description }) => ({ id, name, owaspId, description, systemPrompt: '' }));
}
