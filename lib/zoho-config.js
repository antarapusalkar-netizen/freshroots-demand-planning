const DATA_CENTERS = ['in', 'com', 'eu', 'com.au', 'jp', 'ca', 'sa', 'com.cn'];
const REQUIRED = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'];

// Returns null when the Zoho variables are not set ("Zoho not connected").
export function zohoConfig(env = process.env) {
  if (REQUIRED.some((k) => !env[k])) return null;
  const dc = env.ZOHO_DC || 'in';
  if (!DATA_CENTERS.includes(dc)) throw new Error(`ZOHO_DC must be one of: ${DATA_CENTERS.join(', ')}`);
  return {
    clientId: env.ZOHO_CLIENT_ID,
    clientSecret: env.ZOHO_CLIENT_SECRET,
    refreshToken: env.ZOHO_REFRESH_TOKEN,
    orgId: env.ZOHO_ORG_ID,
    dc,
    accountsUrl: `https://accounts.zoho.${dc}`,
    apiUrl: `https://www.zohoapis.${dc}/inventory/v1`,
  };
}
