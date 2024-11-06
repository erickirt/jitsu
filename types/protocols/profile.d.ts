import { FunctionContext } from "./functions";
import { AnalyticsServerEvent } from "./analytics";

export type ProfileResult = {
  traits: Record<string, any>;
};

export type ProfileBuilderContext = {
  profileBuilder: {
    id: string;
    version: number;
  };
};

export type ProfileFunction = (
  events: Iterable<AnalyticsServerEvent>,
  user: {
    id?: string;
    anonymousId?: string;
    traits: Record<string, any>;
  },
  context: FunctionContext & ProfileBuilderContext
) => Promise<ProfileResult | undefined>;
