export interface IContentMetadata {
  id: number
  slug: string
  name: string
  description: string
  content: string
  absolute_url: string
  uniform_url: string
  type: {
    id: number
    name: string
    name_en: string
    name_plural: string
    title: string
    serial_content: boolean
  }
  original_title: string
  countries: ICountry[]
  genres: IGenre[]
  year: string
  year_start: string
  year_end: string
  is_active: boolean
  age_restriction: string
  smoking_restriction: string
  slogan: string
  poster_url?: string
  studios: any[]
  keywords: string
  provider: IProvider[]
  has_allow_download: boolean
  rating: {
    rating: number
    likes: number
    dislikes: number
    kinopoisk: number
    imdb: number
    ratingNumberPredicted: number
  }
  last_updated_ts: string
  last_video_add_ts: string
  local_release: string
  global_release?: string
  accessibility: string
  sensitive_content: boolean
  seasons_count: number
  can_subscribe?: boolean
  picture: string
  pictires: Record<string, string>
}
export interface ISeasonMetadata {
  number: number
  title: string
  description: string
  picture: string
  url: string
  episode_count: number
}

export interface IVideoInfo {
  id: string
  title: string
  description: string
  description_editors: string
  thumbnail_url: string
  created_ts: string
  video_url: string
  track_id: number
  hits: number
  duration: number
  picture_url: string
  author: {
    id: number
    name: string
    avatar_url: string
    site_url: string
  }
  is_adult: boolean
  publication_ts: string
  hashtags: string[]
  is_livestream: boolean
  comments_count: number
  season: number
  episode: number
  fragment: number
  release: string
  announcement?: string
  type: {
    id: number
    name: string
    title: string
  }
  allow_download: boolean
  all_tags: string[]
  allow_comment: boolean
  is_clickable: boolean
  title_for_card: string
  title_for_player: string
}

export interface IPlayOptions {
  id: number
  track_id: number
  video_id: number
  thumbnail_url: string
  viewer: number
  black_rabbit: boolean
  skin?: string
  appearance: any
  video_balancer: {
    default?: string
  }
  extended_balancer?: Record<string, IDash>
  referer: string
  fts: number
}

export interface ICountry {
  two_letter: string
  name: string
}
export interface IGenre {
  id: number
  name: string
  transliterated_name: string
  main: boolean
  url?: string
}
export interface IProvider {
  id: number
  name: string
  slug: string
}

export interface IDash {
  encrypt_type: string
  stream_type: string
  balancer_url: string
  certificate_url: string
  license_url: string
}