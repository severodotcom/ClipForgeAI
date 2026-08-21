import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const free = await prisma.plan.upsert({
    where: { key: "free" },
    update: {
      name: "Free",
      maxVideosPerMonth: 3,
      maxMinutesPerMonth: 30,
      maxAiAnalysesPerMonth: 10,
      maxClipsPerMonth: 20,
      isActive: true,
    },
    create: {
      key: "free",
      name: "Free",
      maxVideosPerMonth: 3,
      maxMinutesPerMonth: 30,
      maxAiAnalysesPerMonth: 10,
      maxClipsPerMonth: 20,
      isActive: true,
    },
  });

  console.log("Plan seeded:", free);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
