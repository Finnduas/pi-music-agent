// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
// Ambient declaration for the optional native SQLite dependency.
// The store imports it dynamically and treats it as `any`, so a loose
// declaration is sufficient and avoids requiring @types/better-sqlite3.
declare module "better-sqlite3";
