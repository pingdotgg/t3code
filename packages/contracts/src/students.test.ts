import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import * as Students from "./students.ts";

const decodeStudentId = Schema.decodeUnknownEffect(Students.StudentId);
const decodePhoneNumber = Schema.decodeUnknownEffect(Students.PhoneNumber);
const decodeSingaporeAddress = Schema.decodeUnknownEffect(Students.SingaporeAddress);
const decodeParent = Schema.decodeUnknownEffect(Students.Parent);
const decodeStudent = Schema.decodeUnknownEffect(Students.Student);
const decodeStudentRegistryDocument = Schema.decodeUnknownEffect(
  Students.StudentRegistryDocument,
);

describe("Students Schema", () => {
  describe("StudentId", () => {
    it.effect("enforces non-empty string", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(decodeStudentId(""));
        assert.equal(Exit.isFailure(exit), true);
      }),
    );

    it.effect("rejects whitespace-only string", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(decodeStudentId("   "));
        assert.equal(Exit.isFailure(exit), true);
      }),
    );

    it.effect("accepts valid non-empty trimmed string", () =>
      Effect.gen(function* () {
        const id = yield* decodeStudentId("student-123");
        assert.equal(id, "student-123");
      }),
    );

    it.effect("trims whitespace from input", () =>
      Effect.gen(function* () {
        const id = yield* decodeStudentId("  student-123  ");
        assert.equal(id, "student-123");
      }),
    );
  });

  describe("PhoneNumber", () => {
    it.effect("decodes phone number with all fields", () =>
      Effect.gen(function* () {
        const phone = yield* decodePhoneNumber({
          country: "SG",
          number: "91234567",
        });

        assert.deepEqual(phone, {
          country: "SG",
          number: "91234567",
        });
      }),
    );

    it.effect("trims whitespace from country and number", () =>
      Effect.gen(function* () {
        const phone = yield* decodePhoneNumber({
          country: "  SG  ",
          number: "  91234567  ",
        });

        assert.deepEqual(phone, {
          country: "SG",
          number: "91234567",
        });
      }),
    );

    it.effect("rejects empty country", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decodePhoneNumber({
            country: "",
            number: "91234567",
          }),
        );
        assert.equal(Exit.isFailure(exit), true);
      }),
    );

    it.effect("rejects empty number", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decodePhoneNumber({
            country: "SG",
            number: "",
          }),
        );
        assert.equal(Exit.isFailure(exit), true);
      }),
    );
  });

  describe("SingaporeAddress", () => {
    it.effect("decodes address with all fields", () =>
      Effect.gen(function* () {
        const address = yield* decodeSingaporeAddress({
          block: "123",
          street: "Main Street",
          building: "Happy Building",
          unit: "#12-34",
          postalCode: "123456",
        });

        assert.deepEqual(address, {
          block: "123",
          street: "Main Street",
          building: "Happy Building",
          unit: "#12-34",
          postalCode: "123456",
        });
      }),
    );

    it.effect("accepts address with only some fields", () =>
      Effect.gen(function* () {
        const address = yield* decodeSingaporeAddress({
          street: "Main Street",
          postalCode: "123456",
        });

        assert.deepEqual(address, {
          street: "Main Street",
          postalCode: "123456",
        });
      }),
    );

    it.effect("accepts empty address object", () =>
      Effect.gen(function* () {
        const address = yield* decodeSingaporeAddress({});

        assert.deepEqual(address, {});
      }),
    );

    it.effect("trims whitespace from fields", () =>
      Effect.gen(function* () {
        const address = yield* decodeSingaporeAddress({
          block: "  123  ",
          street: "  Main Street  ",
          postalCode: "  123456  ",
        });

        assert.deepEqual(address, {
          block: "123",
          street: "Main Street",
          postalCode: "123456",
        });
      }),
    );
  });

  describe("Parent", () => {
    it.effect("decodes parent with all fields including phone", () =>
      Effect.gen(function* () {
        const parent = yield* decodeParent({
          name: "Jane Doe",
          relationship: "Mother",
          phone: {
            country: "SG",
            number: "98765432",
          },
        });

        assert.deepEqual(parent, {
          name: "Jane Doe",
          relationship: "Mother",
          phone: {
            country: "SG",
            number: "98765432",
          },
        });
      }),
    );

    it.effect("decodes parent without optional phone", () =>
      Effect.gen(function* () {
        const parent = yield* decodeParent({
          name: "Jane Doe",
          relationship: "Mother",
        });

        assert.deepEqual(parent, {
          name: "Jane Doe",
          relationship: "Mother",
        });
      }),
    );

    it.effect("accepts parent with only name", () =>
      Effect.gen(function* () {
        const parent = yield* decodeParent({
          name: "Jane Doe",
        });

        assert.deepEqual(parent, {
          name: "Jane Doe",
        });
      }),
    );

    it.effect("accepts empty parent object", () =>
      Effect.gen(function* () {
        const parent = yield* decodeParent({});

        assert.deepEqual(parent, {});
      }),
    );
  });

  describe("Student", () => {
    it.effect("decodes student with all fields populated", () =>
      Effect.gen(function* () {
        const student = yield* decodeStudent({
          id: "student-123",
          name: "John Smith",
          phone: {
            country: "SG",
            number: "91234567",
          },
          parents: [
            {
              name: "Jane Smith",
              relationship: "Mother",
              phone: {
                country: "SG",
                number: "98765432",
              },
            },
            {
              name: "Bob Smith",
              relationship: "Father",
            },
          ],
          subjects: ["Mathematics", "Physics", "Chemistry"],
          school: "Example Secondary School",
          address: {
            block: "123",
            street: "Main Street",
            building: "Happy Building",
            unit: "#12-34",
            postalCode: "123456",
          },
          notes: "Some notes about the student",
          createdAt: "2026-06-16T00:00:00.000Z",
          updatedAt: "2026-06-16T01:00:00.000Z",
        });

        assert.equal(student.id, "student-123");
        assert.equal(student.name, "John Smith");
        assert.deepEqual(student.phone, { country: "SG", number: "91234567" });
        assert.lengthOf(student.parents!, 2);
        assert.deepEqual(student.subjects, ["Mathematics", "Physics", "Chemistry"]);
      }),
    );

    it.effect("decodes student with only required fields", () =>
      Effect.gen(function* () {
        const student = yield* decodeStudent({
          id: "student-456",
          name: "Alice Brown",
          createdAt: "2026-06-16T00:00:00.000Z",
          updatedAt: "2026-06-16T00:00:00.000Z",
        });

        assert.equal(student.id, "student-456");
        assert.equal(student.name, "Alice Brown");
        assert.isUndefined(student.phone);
        assert.isUndefined(student.parents);
      }),
    );

    it.effect("rejects student with empty name", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decodeStudent({
            id: "student-789",
            name: "",
            createdAt: "2026-06-16T00:00:00.000Z",
            updatedAt: "2026-06-16T00:00:00.000Z",
          }),
        );
        assert.equal(Exit.isFailure(exit), true);
      }),
    );

    it.effect("rejects student with empty id", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decodeStudent({
            id: "",
            name: "Test Student",
            createdAt: "2026-06-16T00:00:00.000Z",
            updatedAt: "2026-06-16T00:00:00.000Z",
          }),
        );
        assert.equal(Exit.isFailure(exit), true);
      }),
    );

    it.effect("trims whitespace from name", () =>
      Effect.gen(function* () {
        const student = yield* decodeStudent({
          id: "student-999",
          name: "  Test Student  ",
          createdAt: "2026-06-16T00:00:00.000Z",
          updatedAt: "2026-06-16T00:00:00.000Z",
        });

        assert.equal(student.name, "Test Student");
      }),
    );
  });

  describe("StudentRegistryDocument", () => {
    it.effect("decodes document with populated students array", () =>
      Effect.gen(function* () {
        const document = yield* decodeStudentRegistryDocument({
          version: "1",
          students: [
            {
              id: "student-1",
              name: "Alice",
              createdAt: "2026-06-16T00:00:00.000Z",
              updatedAt: "2026-06-16T00:00:00.000Z",
            },
            {
              id: "student-2",
              name: "Bob",
              createdAt: "2026-06-16T00:00:00.000Z",
              updatedAt: "2026-06-16T00:00:00.000Z",
            },
          ],
        });

        assert.equal(document.version, "1");
        assert.lengthOf(document.students, 2);
        assert.equal(document.students[0]?.name, "Alice");
        assert.equal(document.students[1]?.name, "Bob");
      }),
    );

    it.effect("decodes document with empty students array", () =>
      Effect.gen(function* () {
        const document = yield* decodeStudentRegistryDocument({
          version: "1",
          students: [],
        });

        assert.equal(document.version, "1");
        assert.deepEqual(document.students, []);
      }),
    );

    it.effect("rejects document with empty version", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decodeStudentRegistryDocument({
            version: "",
            students: [],
          }),
        );
        assert.equal(Exit.isFailure(exit), true);
      }),
    );

    it.effect("trims whitespace from version", () =>
      Effect.gen(function* () {
        const document = yield* decodeStudentRegistryDocument({
          version: "  1  ",
          students: [],
        });

        assert.equal(document.version, "1");
      }),
    );
  });
});
