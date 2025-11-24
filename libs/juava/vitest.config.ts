import { mergeConfig } from "vitest/config";
import baseConfig from "@jitsu/common-config/vitest.config";

export default mergeConfig(baseConfig, {
  test: {
    env: {
      KAFKA_BOOTSTRAP_SERVERS: "localhost:9092",
      BULKER_URL: "http://localhost:3000",
      BULKER_AUTH_KEY: "test-auth-key",
      REPOSITORY_BASE_URL: "http://localhost:3000",
    },
  },
});
