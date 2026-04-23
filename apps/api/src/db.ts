import fp from "fastify-plugin";
import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import type { FastifyInstance } from "fastify";
import type { ProjectDoc, ThumbnailDoc, UserDoc } from "./types.js";

export type MongoContext = {
  client: MongoClient;
  db: Db;
  users: Collection<UserDoc>;
  projects: Collection<ProjectDoc>;
  thumbnails: Collection<ThumbnailDoc>;
};

declare module "fastify" {
  interface FastifyInstance {
    mongo: MongoContext;
  }
}

export type MongoPluginOptions = {
  uri: string;
  dbName: string;
};

async function ensureIndexes(db: Db) {
  const users = db.collection<UserDoc>("users");
  const projects = db.collection<ProjectDoc>("projects");
  const thumbnails = db.collection<ThumbnailDoc>("project_thumbnails");

  await users.createIndex({ sub: 1 }, { unique: true });
  await users.createIndex({ email: 1 });

  await projects.createIndex({ userId: 1 });
  await projects.createIndex({ userId: 1, status: 1, updatedAt: -1 });

  await thumbnails.createIndex({ userId: 1, status: 1, lastViewedAt: -1 });
}

export const mongoPlugin = fp<MongoPluginOptions>(
  async (app: FastifyInstance, opts: MongoPluginOptions) => {
    const client = new MongoClient(opts.uri);
    await client.connect();
    const db = client.db(opts.dbName);

    await ensureIndexes(db);

    const context: MongoContext = {
      client,
      db,
      users: db.collection<UserDoc>("users"),
      projects: db.collection<ProjectDoc>("projects"),
      thumbnails: db.collection<ThumbnailDoc>("project_thumbnails")
    };

    app.decorate("mongo", context);

    app.addHook("onClose", async () => {
      await client.close();
    });
  },
  {
    name: "muralist-mongo",
    fastify: "4.x"
  }
);

export type { Document };
