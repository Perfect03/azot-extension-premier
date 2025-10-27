import type { IContentMetadata, IPlayOptions, IVideoInfo, ISeasonMetadata } from './types';
import {  DEFAULT_HEADERS, ROUTES } from './constants';
import { auth, exit } from './auth';

const request = async <T>(url: string, method: string = 'GET', params?: Record<string, string|number>) => {
  console.debug(`Getting data from ${url}...`);

  const query = new URLSearchParams(params || {}).toString();

  const response = await fetch(`${url}?${query}`, {
    method,
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': method == 'GET' ? '*/*' : 'application/json',
      Authorization: `JWTBearer ${localStorage.getItem('umaAccessToken')}`,
    },
  });
  const data = (await response.text()) || '';
  if (response.status === 401) {
    console.error(`Unauthorized: ${url}?${query}`);
    console.debug(data);
    exit();
    const login = await auth();
    if (login?.authentication_token) {
      await request(url, method, params);
    }
    return;
  }
  
  response.status === 400 && console.error(`Bad Request: ${url}?${query}`);
  const isSuccess = response.status === 200;
  if (!isSuccess) console.debug(`Request failed. Route: ${url}?${query}. ${data}`);
  try {
    const parsed = JSON.parse(data)
    if (parsed.success === false) {
      exit();
      console.error(parsed.message || 'Unexpected Error');
      await auth();
      await request(url, method, params);
      return;
    }
    return parsed as T;
  } catch (e) {
    console.debug(data);
    console.debug(e as any);
    console.error(`Parsing JSON response failed. Route: ${url}?${query}`);
    process.exit(1);
  }
};

export const fetchTitleMetainfo = async (slug: string) => {
  return request<IContentMetadata>(`${ROUTES.metainfo(slug)}`);
};

export const fetchSeasonMetainfo = async (slug: string) => {
  return request<ISeasonMetadata[]>(`${ROUTES.season(slug)}`);
};

export const fetchVideoInfo = async (slug: string, type: 'movie'|'series' = 'movie', season: number = 0) => {
  if (type == 'movie') {
    const results = await request<{results: IVideoInfo[]}>(ROUTES.videoinfo(slug)) ?? {results: [] as IVideoInfo[]}
    return results.results
  }
  else {
    let page = 1;
    const limit = 100;
    let results: IVideoInfo[] = [];
    let hasNext = true;

    while (hasNext) {
      const response = await request<{
        results: IVideoInfo[];
        has_next: boolean;
      }>(ROUTES.videoinfo(slug), 'GET', { page, limit, season });

      if (response) results = results.concat(response.results);
      hasNext = Boolean(response?.has_next);
      page++;
    }

    return results;
  }
};

export const fetchPlayOptions = async (contentId: string) => {
  return request<IPlayOptions>(ROUTES.playOptions(contentId));
};
