import forge from 'node-forge';
import * as fs from 'fs';
import * as path from 'path';

export interface CACert {
  cert: forge.pki.Certificate;
  key: forge.pki.PrivateKey;
  certPem: string;
  keyPem: string;
}

// Set by Electron main process, falls back to cwd for standalone/test use
let _certDir: string | null = null;

export function setCertDir(dir: string): void {
  _certDir = dir;
}

function getCertDir(): string {
  if (_certDir) return _certDir;
  return path.join(process.cwd(), '.sniff-certs');
}

export async function generateCACertificate(): Promise<CACert> {
  const certDir = getCertDir();
  const caCertPath = path.join(certDir, 'sniff-ca.pem');
  const caKeyPath = path.join(certDir, 'sniff-ca-key.pem');

  // Try to load existing CA
  if (fs.existsSync(caCertPath) && fs.existsSync(caKeyPath)) {
    const certPem = fs.readFileSync(caCertPath, 'utf-8');
    const keyPem = fs.readFileSync(caKeyPath, 'utf-8');
    return {
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
      certPem,
      keyPem,
    };
  }

  // Generate new CA
  console.log('[ca] generating new CA certificate...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'Sniff Proxy CA' },
    { name: 'organizationName', value: 'Sniff' },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      cRLSign: true,
    },
    {
      name: 'subjectKeyIdentifier',
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Persist
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(caCertPath, certPem);
  fs.writeFileSync(caKeyPath, keyPem, { mode: 0o600 });

  console.log('[ca] CA certificate generated and saved');

  return { cert, key: keys.privateKey, certPem, keyPem };
}

export function generateHostCertificate(
  ca: CACert,
  hostname: string,
): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(ca.cert.subject.attributes);

  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: hostname }, // DNS
      ],
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
    },
  ]);

  cert.sign(ca.key as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export function getCACertPem(): string | null {
  const certDir = getCertDir();
  const caCertPath = path.join(certDir, 'sniff-ca.pem');
  if (fs.existsSync(caCertPath)) {
    return fs.readFileSync(caCertPath, 'utf-8');
  }
  return null;
}
