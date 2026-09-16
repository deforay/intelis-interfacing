export interface LisApiConfig {
  url: string;
  authType: 'none' | 'bearer' | 'basic' | 'apikey';
  credentials: {
    token?: string;
    username?: string;
    password?: string;
    apiKey?: string;
  };
  fetchInstruments: {
    enabled: boolean;
    endpoint: string;
  };
}

export interface LisInstrument {
  name: string;
}

export interface LisApiResponse {
  instruments: LisInstrument[];
}
