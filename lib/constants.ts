export const HOSTNAME = 'premier.one'

export const DOMAINS = {
  www: `https://${HOSTNAME}`,
  api: `https://${HOSTNAME}/uma-api`,
}

export const DEVICE = {
  applicationVersion: '2.43.9',
  os: 'smart_tv',
  osVersion: '12.1',
  deviceModel: 'SmartTV',
  deviceName: '16464673'
}

export const DEFAULT_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'x-device-id': DEVICE.deviceName,
  'x-device-type': DEVICE.os,
  Origin: 'https://hisensesmarttv.premier.one',
  Referer: 'https://hisensesmarttv.premier.one/'
}

export const ROUTES = {
  smartRegister: `${DOMAINS.www}/app/v1.1.3/device/smart/register`,
  smartCheck: (code: string) => `${DOMAINS.www}/app/v1.2/device/smart/check/${code}`,
  metainfo: (slug: string) => `${DOMAINS.api}/metainfo/tv/${slug}`,
  season: (slug: string) => `${DOMAINS.api}/metainfo/tv/${slug}/season`,
  videoinfo: (slug: string) => `${DOMAINS.api}/metainfo/tv/${slug}/video`,
  playOptions: (contentId: string) => `${DOMAINS.www}/api/play/options/${contentId}`
}
