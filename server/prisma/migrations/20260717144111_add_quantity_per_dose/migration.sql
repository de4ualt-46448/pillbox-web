-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Medication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "frequencyRaw" TEXT NOT NULL,
    "timesOfDay" TEXT NOT NULL,
    "totalQuantity" INTEGER NOT NULL,
    "pillsRemaining" INTEGER NOT NULL,
    "quantityPerDose" INTEGER NOT NULL DEFAULT 1,
    "voiceProfileId" TEXT,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    CONSTRAINT "Medication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Medication" ("dosage", "frequencyRaw", "id", "lowStockThreshold", "name", "pillsRemaining", "timesOfDay", "totalQuantity", "userId", "voiceProfileId") SELECT "dosage", "frequencyRaw", "id", "lowStockThreshold", "name", "pillsRemaining", "timesOfDay", "totalQuantity", "userId", "voiceProfileId" FROM "Medication";
DROP TABLE "Medication";
ALTER TABLE "new_Medication" RENAME TO "Medication";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
