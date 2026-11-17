import { trustOnlyLocalProxyHop } from './app.setup.js';

describe('trustOnlyLocalProxyHop', () => {
  it('trusts only the direct peer (hop 0) and only when it is loopback', () => {
    expect(trustOnlyLocalProxyHop('127.0.0.1', 0)).toBe(true);
    expect(trustOnlyLocalProxyHop('::1', 0)).toBe(true);
    expect(trustOnlyLocalProxyHop('::ffff:127.0.0.1', 0)).toBe(true);
  });

  it('never trusts a second hop, even if it claims to be loopback', () => {
    expect(trustOnlyLocalProxyHop('127.0.0.1', 1)).toBe(false);
  });

  it('never trusts non-loopback peers', () => {
    expect(trustOnlyLocalProxyHop('192.168.1.20', 0)).toBe(false);
    expect(trustOnlyLocalProxyHop('10.0.0.1', 0)).toBe(false);
    expect(trustOnlyLocalProxyHop('127.0.0.2', 0)).toBe(false);
  });
});
