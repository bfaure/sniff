import { describe, it, expect } from 'vitest';
import { globMatch, parseUrl } from './scope.js';

describe('globMatch', () => {
  it('matches exact strings', () => {
    expect(globMatch('example.com', 'example.com')).toBe(true);
    expect(globMatch('example.com', 'other.com')).toBe(false);
  });

  it('matches wildcard prefix', () => {
    expect(globMatch('*.example.com', 'api.example.com')).toBe(true);
    expect(globMatch('*.example.com', 'sub.api.example.com')).toBe(true);
    expect(globMatch('*.example.com', 'example.com')).toBe(false);
  });

  it('matches single char wildcard', () => {
    expect(globMatch('example.co?', 'example.com')).toBe(true);
    expect(globMatch('example.co?', 'example.co')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(globMatch('Example.Com', 'example.com')).toBe(true);
  });

  it('matches path patterns', () => {
    expect(globMatch('/api/*', '/api/users')).toBe(true);
    expect(globMatch('/api/*', '/api/users/123')).toBe(true);
    expect(globMatch('/api/*', '/other')).toBe(false);
  });

  it('escapes regex special chars', () => {
    expect(globMatch('example.com', 'exampleXcom')).toBe(false);
  });
});

describe('parseUrl', () => {
  it('parses HTTP URLs', () => {
    const result = parseUrl('http://example.com/path?q=1');
    expect(result.protocol).toBe('http');
    expect(result.host).toBe('example.com');
    expect(result.port).toBe(null);
    expect(result.path).toBe('/path?q=1');
  });

  it('parses HTTPS URLs with port', () => {
    const result = parseUrl('https://example.com:8443/api');
    expect(result.protocol).toBe('https');
    expect(result.host).toBe('example.com');
    expect(result.port).toBe(8443);
    expect(result.path).toBe('/api');
  });

  it('handles invalid URLs gracefully', () => {
    const result = parseUrl('not-a-url');
    expect(result.host).toBe('');
  });
});
