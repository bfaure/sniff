export const config = {
  serverPort: parseInt(process.env.SNIFF_SERVER_PORT || '47120', 10),
  proxyPort: parseInt(process.env.SNIFF_PROXY_PORT || '8080', 10),
};
