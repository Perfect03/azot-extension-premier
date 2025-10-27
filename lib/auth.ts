import { DEFAULT_HEADERS, ROUTES, DEVICE } from './constants';
import { input } from 'azot';

export const checkAuth = async () => {
  const token = localStorage.getItem('accessToken')
  const expires = localStorage.getItem('expiresAt')
  if (token && expires) {
    if (Date.parse(expires) < Date.now()) {
      console.log('Время жизни токена истекло. Пожалуйста, авторизуйтесь заново:');
    }
    else return;
  }
  await auth();
};

export const registerDevice = async () => {
  console.debug('Регистрация устройства...');

  const response = await fetch(ROUTES.smartRegister, {
    method: 'POST',
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(DEVICE),
  });

  if (response.status !== 200) {
    throw new Error('Ошибка при регистрации устройства');
  }

  const data = await response.json();
  return data.result.activationCode;
}

export const checkDevice = async (code: string) => {
  console.debug('Confirm registering device...');

  const response = await fetch(ROUTES.smartCheck(code), {
    headers: DEFAULT_HEADERS,
  });

  if (response.status == 200) {
    const device = await response.json()
    if (device?.result?.isActivated) saveAuth({
      expiresAt: device.result.device.accessTokenExpiredAt,
      accessToken: device.result.device.accessToken,
      refreshToken: device.result.device.refreshToken,
      umaAccessToken: device.result.device.umaTokens.accessToken,
      umaRefreshToken: device.result.device.umaTokens.refreshToken,
      deviceId: device.result.device.id
    })
    return device
  }
}


export const auth = async () => {
  let confirmationAttempts = 0;
  const maxConfirmationAttempts = 10;

  while (confirmationAttempts < maxConfirmationAttempts) {
    confirmationAttempts++;

    try {
      const activationCode = await registerDevice();
      console.log(`Введите код ${activationCode} на https://premier.one/profile/tv`);
      await input(`Введите код ${activationCode} на https://premier.one/profile/tv`, { fields: { confirm: { label: 'Нажмите Enter, когда устройство будет подключено', type: 'confirm' } }})

      const authData = await checkDevice(activationCode);
      console.debug(`Profile: ${authData}`);

      if (authData?.result?.user?.username) return authData;
      else {
        console.error("Код не был активирован. Пожалуйста, повторите попытку");
        await auth();
        return;
      }
    } catch (error) {
      console.error('Authorization error:', error.message);
      throw error;
    }
  }

  throw new Error('The maximum number of code entry attempts has been exceeded');
}

const saveAuth = (data: Record<string, string>) => {
  Object.entries(data).forEach(([key, value]) => localStorage.setItem(key, value))
}

export const exit = async () => {
  localStorage.clear();
};
