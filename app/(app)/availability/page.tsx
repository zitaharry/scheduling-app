import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import React from "react";

const AvailabilityPage = async () => {
  const { userId } = await auth();

  if (!userId) {
    redirect("/");
  }

  return <div>AvailabilityPage</div>;
};
export default AvailabilityPage;
