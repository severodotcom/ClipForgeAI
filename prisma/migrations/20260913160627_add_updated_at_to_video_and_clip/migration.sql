/*
  Warnings:

  - Added the required column `updatedAt` to the `Clip` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Video` table without a default value. This is not possible if the table is not empty.

  Existing rows are backfilled from `createdAt` (best available approximation —
  no update has been recorded for them yet), then the column is made NOT NULL.
*/
-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "updatedAt" TIMESTAMP(3);
UPDATE "Clip" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Clip" ALTER COLUMN "updatedAt" SET NOT NULL;

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "updatedAt" TIMESTAMP(3);
UPDATE "Video" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Video" ALTER COLUMN "updatedAt" SET NOT NULL;
